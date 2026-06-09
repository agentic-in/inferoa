import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

function config(baseUrl: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.omni.enabled = true;
  next.omni.endpoints.vision = {
    base_url: baseUrl,
    model: "vision-model",
  };
  next.omni.endpoints.image_generation = {
    base_url: baseUrl,
    model: "image-model",
  };
  next.omni.endpoints.audio_generation = {
    base_url: baseUrl,
    model: "stable-audio",
  };
  next.omni.endpoints.image_edit = {
    base_url: baseUrl,
    model: "image-edit-model",
  };
  next.omni.endpoints.speech = {
    base_url: baseUrl,
    model: "qwen3-tts",
  };
  next.omni.endpoints.video_generation = {
    base_url: baseUrl,
    model: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
  };
  return next;
}

function visionConfig(baseUrl: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.omni.enabled = true;
  next.omni.endpoints.vision = {
    base_url: baseUrl,
    model: "vision-model",
  };
  return next;
}

test("vision understanding and image generation use endpoint-backed requests and managed resources", async () => {
  let chatBody: Record<string, unknown> | undefined;
  let imageBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        chatBody = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "The image is a tiny fixture." } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        imageBody = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: "ZmFrZS1pbWFnZQ==", revised_prompt: "tiny fixture" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-vision-image-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const imagePath = path.join(dir, "fixture.png");
    await writeFile(imagePath, Buffer.from("fake-png"));
    const workspace: WorkspaceIdentity = { id: "w_omni_vision_image", root: dir, alias: "omni-vision-image" };
    const session = store.createSession(workspace, "omni-vision-image");
    const registry = new ToolRegistry(config(baseUrl), workspace, store);

    const vision = await registry.call(
      { id: "vision", name: "vision_understanding", arguments: { inputs: ["fixture.png"], prompt: "What is in the image?" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(vision.ok, true);
    assert.equal(vision.data?.answer, "The image is a tiny fixture.");
    assert.match(JSON.stringify(chatBody), /data:image\/png;base64/);

    const image = await registry.call(
      { id: "image", name: "image_generation", arguments: { prompt: "tiny fixture", size: "256x256", seed: 7 } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(image.ok, true);
    assert.equal(image.data?.media_count, 1);
    assert.equal(Object.hasOwn(image.data ?? {}, "media"), false);
    assert.deepEqual(imageBody, { model: "image-model", prompt: "tiny fixture", size: "256x256", seed: 7 });
    const imageResources = image.data?.resources as Array<{ uri: string; content_type: string; bytes: number }>;
    assert.equal(imageResources[0]?.content_type, "image/png");
    assert.equal(store.readResource(imageResources[0]!.uri)?.content, Buffer.from("fake-image").toString("base64"));
    const stored = store.readResource(image.resource_uri!);
    assert.match(stored?.content ?? "", /ZmFrZS1pbWFnZQ==/);
    assert.equal(stored?.metadata.media_count, 1);
    assert.equal(stored?.metadata.primary_media_resource, imageResources[0]?.uri);
    assert.deepEqual(stored?.metadata.media_resources, [imageResources[0]?.uri]);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("video_generation follows the vLLM-Omni async video job lifecycle", async () => {
  let polls = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/videos") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "vid_1", status: "queued" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/vid_1") {
      polls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "vid_1", status: polls >= 2 ? "completed" : "running" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/vid_1/content") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.from("fake-video"));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-video-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_omni", root: dir, alias: "omni" };
    const session = store.createSession(workspace, "omni");
    const registry = new ToolRegistry(config(baseUrl), workspace, store);
    const result = await registry.call(
      {
        id: "omni-video",
        name: "video_generation",
        arguments: { prompt: "A GPU rack booting Inferoa", poll_ms: 1, timeout_ms: 1000 },
      },
      { session_id: session.session_id, run_id: "run" },
    );

    assert.equal(result.ok, true);
    assert.equal(polls, 2);
    assert.equal(result.data?.media_count, 1);
    const resources = result.data?.resources as Array<{ uri?: string; content_type?: string; bytes?: number }>;
    assert.equal(resources[0]?.content_type, "video/mp4");
    assert.equal(resources[0]?.bytes, Buffer.byteLength("fake-video"));
    const stored = store.readResource(resources[0]!.uri!);
    assert.equal(stored?.content, Buffer.from("fake-video").toString("base64"));
    assert.equal(store.readResource(result.resource_uri!)?.metadata.media_resource, resources[0]!.uri);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resource URIs feed Omni tool inputs with API-aligned payloads", async () => {
  const seen: Array<{ method?: string; url?: string; body?: string; contentType?: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, body, contentType: req.headers["content-type"] });
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/images/edits") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("edited-image").toString("base64") }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "saw chained image" } }], usage: {} }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.from("fake-speech"));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/audio/generate") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.from("fake-audio-output"));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/videos/sync") {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(Buffer.from("fake-video-output"));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-resource-chain-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_omni_resource_chain", root: dir, alias: "omni-resource-chain" };
    const session = store.createSession(workspace, "omni-resource-chain");
    const registry = new ToolRegistry(config(baseUrl), workspace, store);

    const generated = await registry.call(
      { id: "image", name: "image_generation", arguments: { prompt: "tiny fixture", size: "256x256" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(generated.ok, true);

    const edited = await registry.call(
      { id: "edit", name: "image_edit", arguments: { prompt: "make brighter", images: [generated.resource_uri!] } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(edited.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/images/edits")?.body ?? "", /fake-image/);

    const vision = await registry.call(
      { id: "vision", name: "vision_understanding", arguments: { inputs: [generated.resource_uri!], prompt: "describe" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(vision.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/chat/completions")?.body ?? "", /data:image\/png;base64,ZmFrZS1pbWFnZQ==/);

    const audioResource = store.putResource(session.session_id, "omni.test.audio.media", Buffer.from("fake-audio").toString("base64"), {
      content_type: "audio/wav",
      encoding: "base64",
      bytes: Buffer.byteLength("fake-audio"),
    });
    const speech = await registry.call(
      { id: "speech", name: "speech_generation", arguments: { input: "hello", voice: "vivian", ref_audio: audioResource.uri } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(speech.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/audio/speech")?.body ?? "", /data:audio\/wav;base64,ZmFrZS1hdWRpbw==/);

    const textResource = store.putResource(session.session_id, "unit.prompt", "rain on glass", { content_type: "text/plain" });
    const audio = await registry.call(
      { id: "audio", name: "audio_generation", arguments: { input: textResource.uri, response_format: "wav" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(audio.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/audio/generate")?.body ?? "", /"input":"rain on glass"/);

    const mediaPrompt = await registry.call(
      { id: "bad-audio", name: "audio_generation", arguments: { input: audioResource.uri, response_format: "wav" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(mediaPrompt.ok, false);
    assert.equal(mediaPrompt.error?.code, "invalid_resource_for_text_prompt");

    const videoResource = store.putResource(session.session_id, "omni.test.video.media", Buffer.from("fake-video").toString("base64"), {
      content_type: "video/mp4",
      encoding: "base64",
      bytes: Buffer.byteLength("fake-video"),
    });
    const imageReference = await registry.call(
      { id: "video-image-ref", name: "video_generation", arguments: { prompt: "short clip", mode: "sync", image_reference: generated.resource_uri! } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(imageReference.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/videos/sync")?.body ?? "", /"image_url":"data:image\/png;base64,ZmFrZS1pbWFnZQ=="/);

    const videoReference = await registry.call(
      { id: "video-video-ref", name: "video_generation", arguments: { prompt: "short clip", mode: "sync", video_reference: videoResource.uri } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(videoReference.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/videos/sync")?.body ?? "", /"video_url":"data:video\/mp4;base64,ZmFrZS12aWRlbw=="/);

    const inputReference = await registry.call(
      { id: "video-input-ref", name: "video_generation", arguments: { prompt: "short clip", mode: "sync", input_reference: videoResource.uri } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(inputReference.ok, true);
    assert.match(seen.findLast((entry) => entry.url === "/v1/videos/sync")?.body ?? "", /fake-video/);

    const conflict = await registry.call(
      {
        id: "video-conflict",
        name: "video_generation",
        arguments: { prompt: "short clip", mode: "sync", input_reference: videoResource.uri, video_reference: videoResource.uri },
      },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error?.code, "video_generation_reference_conflict");
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation tools store audio, speech, image edit, and sync video results as managed resources", async () => {
  const seen: Array<{ method?: string; url?: string; body?: string; contentType?: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, body, contentType: req.headers["content-type"] });
      if (req.method === "POST" && req.url === "/v1/audio/generate") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.from("fake-audio"));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.from("fake-speech"));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/audio/voices") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ voices: ["vivian", "ryan"] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/images/edits") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: "ZmFrZS1pbWFnZQ==" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/videos/sync") {
        res.writeHead(200, { "content-type": "video/mp4", "x-model": "video-model" });
        res.end(Buffer.from("fake-sync-video"));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-tools-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_omni_tools", root: dir, alias: "omni-tools" };
    const session = store.createSession(workspace, "omni-tools");
    const registry = new ToolRegistry(config(baseUrl), workspace, store);

    const audio = await registry.call(
      { id: "audio", name: "audio_generation", arguments: { input: "rain on glass", response_format: "wav" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(audio.ok, true);
    assert.match(seen.find((entry) => entry.url === "/v1/audio/generate")?.body ?? "", /"input":"rain on glass"/);
    assert.equal(store.readResource((audio.data?.resources as Array<{ uri: string }>)[0]!.uri)?.content, Buffer.from("fake-audio").toString("base64"));

    const speech = await registry.call(
      { id: "speech", name: "speech_generation", arguments: { input: "hello", voice: "vivian" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(speech.ok, true);
    assert.equal(store.readResource((speech.data?.resources as Array<{ uri: string }>)[0]!.uri)?.content, Buffer.from("fake-speech").toString("base64"));

    const voices = await registry.call(
      { id: "voices", name: "speech_voices", arguments: {} },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.deepEqual(voices.data?.voices, ["vivian", "ryan"]);

    const imageEdit = await registry.call(
      { id: "image-edit", name: "image_edit", arguments: { prompt: "make it brighter", images: ["https://example.test/image.png"] } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(imageEdit.ok, true);
    assert.equal(imageEdit.data?.media_count, 1);
    const imageEditResources = imageEdit.data?.resources as Array<{ uri: string; content_type: string }>;
    assert.equal(imageEditResources[0]?.content_type, "image/png");
    assert.equal(store.readResource(imageEditResources[0]!.uri)?.content, Buffer.from("fake-image").toString("base64"));
    assert.equal(store.readResource(imageEdit.resource_uri!)?.metadata.primary_media_resource, imageEditResources[0]?.uri);
    assert.match(seen.find((entry) => entry.url === "/v1/images/edits")?.body ?? "", /make it brighter/);

    const video = await registry.call(
      { id: "video-sync", name: "video_generation", arguments: { prompt: "short clip", mode: "sync", seconds: "1", extra_params: { scheduler: "fast" } } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(video.ok, true);
    assert.equal(store.readResource((video.data?.resources as Array<{ uri: string }>)[0]!.uri)?.content, Buffer.from("fake-sync-video").toString("base64"));
    assert.match(seen.find((entry) => entry.url === "/v1/videos/sync")?.body ?? "", /scheduler/);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision_understanding accepts external local image paths", async () => {
  let postedBody = "";
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        postedBody += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "saw image" } }], usage: {} }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-vision-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-vision-external-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspaceRoot = path.join(dir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const imageFile = path.join(externalDir, "Dragged Image.png");
    await writeFile(imageFile, Buffer.from("fake-image"));

    const workspace: WorkspaceIdentity = { id: "w_omni_vision", root: workspaceRoot, alias: "omni-vision" };
    const session = store.createSession(workspace, "omni-vision");
    const registry = new ToolRegistry(visionConfig(baseUrl), workspace, store);
    const result = await registry.call(
      {
        id: "omni-vision",
        name: "vision_understanding",
        arguments: { inputs: [pathToFileURL(imageFile).href], prompt: "describe" },
      },
      { session_id: session.session_id, run_id: "run" },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(postedBody, /data:image\/png;base64,/);
    assert.doesNotMatch(postedBody, /file:\/\/\//);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});
