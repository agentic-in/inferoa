import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildOmniCapabilityMatrix, staticOmniCapabilityMatrix } from "../src/model/omni-capabilities.js";

test("static Omni capability matrix includes endpoint-backed vLLM-Omni surfaces", () => {
  const matrix = staticOmniCapabilityMatrix(structuredClone(DEFAULT_CONFIG));

  assert.deepEqual(matrix.map((capability) => capability.name), [
    "vision",
    "image_generation",
    "image_edit",
    "video_understanding",
    "video_generation",
    "audio_understanding",
    "audio_generation",
    "speech_generation",
    "speech_voices",
  ]);
  assert.deepEqual(
    matrix.filter((capability) => capability.required_for_acceptance).map((capability) => capability.name),
    ["vision", "image_generation", "video_generation"],
  );
  assert.equal(matrix.find((capability) => capability.name === "image_generation")?.configured, false);
});

test("Omni capability matrix probes OpenAPI routes for configured endpoint profiles", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        paths: {
          "/v1/chat/completions": {},
          "/v1/images/generations": {},
          "/v1/videos": {},
          "/v1/videos/sync": {},
          "/v1/audio/speech": {},
          "/v1/audio/voices": {},
        },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.omni.enabled = true;
    config.omni.endpoints.vision = { base_url: baseUrl, model: "vision-model" };
    config.omni.endpoints.image_generation = { base_url: baseUrl, model: "image-model" };
    config.omni.endpoints.video_generation = { base_url: baseUrl, model: "video-model" };
    config.omni.endpoints.audio_generation = { base_url: baseUrl, model: "audio-model" };
    config.omni.endpoints.speech = { base_url: baseUrl, model: "tts-model" };

    const matrix = await buildOmniCapabilityMatrix(config);
    const byName = new Map(matrix.map((capability) => [capability.name, capability]));

    assert.equal(byName.get("vision")?.route_present, true);
    assert.equal(byName.get("image_generation")?.route_present, true);
    assert.equal(byName.get("video_generation")?.route_present, true);
    assert.equal(byName.get("speech_generation")?.route_present, true);
    assert.equal(byName.get("speech_voices")?.route_present, true);
    assert.equal(byName.get("audio_generation")?.configured, true);
    assert.equal(byName.get("audio_generation")?.route_present, false);
    assert.match(byName.get("audio_generation")?.unavailable_reason ?? "", /audio\/generate/);
    assert.equal(byName.get("image_edit")?.unavailable_reason, "not configured");
    assert.deepEqual(seen, ["/openapi.json"]);
  } finally {
    server.close();
  }
});
