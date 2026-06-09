import { useEffect, useRef } from "react";
import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./index.module.css";

const modules = [
  ["01", "Prefix-cache discipline", "Stable prompt epochs and deterministic tool schemas protect reusable session prefixes."],
  ["02", "Context Optimization", "Compression, graph-shaped repo context, and bounded tool output reduce token waste while preserving evidence."],
  ["03", "Intelligent routing", "Route by cost, safety, privacy, capability, and pressure across self-hosted vLLM models and external frontier models."],
  ["04", "vLLM serving", "High-throughput, memory-efficient inference keeps cache, latency, cost, and multimodal signals native."],
];

const stackFlow = [
  ["Agent Harness", "Inferoa + prefix discipline"],
  ["Context Optimization", "compression, graph, bounded tools"],
  ["Intelligent Routing", "vLLM SR"],
  ["vLLM Serving", "Engine + Omni"],
];

const sessionScreens = [
  {
    title: "Welcome",
    body: "A restrained entry point for the configured model, workspace, and core commands.",
    image: "/img/screenshots/inferoa-welcome.png",
  },
  {
    title: "Goal Mode",
    body: "Long-horizon work keeps objective, plan status, and evidence visible across turns.",
    image: "/img/screenshots/inferoa-goal.png",
  },
  {
    title: "Prefix Cache Status",
    body: "Every response can surface prefix-cache health without making the chat noisy.",
    image: "/img/screenshots/inferoa-prefix-cache-status.png",
  },
  {
    title: "Tokenmaxxing",
    body: "Prefix cache, tool-output savings, recent turn usage, and model-selection pressure stay visible together.",
    image: "/img/screenshots/tokenmaxxing.png",
  },
  {
    title: "Plan Scope",
    body: "Plan mode captures user intent before execution and keeps the loop inspectable.",
    image: "/img/screenshots/inferoa-plan-clarify.png",
  },
  {
    title: "Plan Approval",
    body: "Execution starts only after the concrete plan is ready and confirmed.",
    image: "/img/screenshots/inferoa-plan-ready.png",
  },
  {
    title: "Autoresearch Setup",
    body: "Experiment goals become part of the same durable coding session.",
    image: "/img/screenshots/inferoa-autoresearch-start.png",
  },
  {
    title: "Autoresearch Iteration",
    body: "Benchmark runs, failures, fixes, and metrics stay in one research loop.",
    image: "/img/screenshots/inferoa-autoresearch-iteration.png",
  },
];

export default function Home(): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const vllmLogo = useBaseUrl("/img/vllm-logo-text-light.png");
  const srLogo = useBaseUrl("/img/vllm-sr-logo.light.png");
  const omniLogo = useBaseUrl("/img/vllm-omni-logo.png");
  const shareImage = "https://inferoa.agentic-in.ai/img/inferoa-line-hero.png";
  const ecosystem = [
    {
      name: "vLLM Engine",
      img: vllmLogo,
      href: "https://github.com/vllm-project/vllm",
      body: "High-performance serving is the base. inferoa treats prefix-cache stability and endpoint signals as agent state.",
    },
    {
      name: "vLLM Semantic Router",
      img: srLogo,
      href: "https://github.com/vllm-project/semantic-router",
      body: "Routing belongs in the loop. Cost, safety, privacy, capability, and session pressure can choose the model path.",
    },
    {
      name: "vLLM Omni",
      img: omniLogo,
      href: "https://github.com/vllm-project/vllm-omni",
      body: "Multimodal work stays native. Image, video, and audio understanding or generation live in the same durable session.",
    },
  ];

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    async function mountScene() {
      const THREE = await import("three");
      if (!canvasRef.current || disposed) {
        return;
      }

      const container = canvasRef.current;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#F5F4EF");
      scene.fog = new THREE.FogExp2("#F5F4EF", 0.018);

      const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 1000);
      camera.position.set(0, 0, 25);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(container.clientWidth, container.clientHeight);
      container.appendChild(renderer.domElement);

      scene.add(new THREE.AmbientLight(0xffffff, 0.78));
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.88);
      keyLight.position.set(10, 16, 12);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xefe8dc, 0.5);
      fillLight.position.set(-12, -4, -10);
      scene.add(fillLight);

      const group = new THREE.Group();
      scene.add(group);

      const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
      const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);
      const cubeMaterials = [
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.03 }),
        new THREE.MeshStandardMaterial({ color: 0xeaeae4, roughness: 0.55, metalness: 0.02 }),
        new THREE.MeshStandardMaterial({ color: 0xeae1f8, roughness: 0.58, metalness: 0.02 }),
        new THREE.MeshStandardMaterial({ color: 0xfbee8e, roughness: 0.62, metalness: 0.01 }),
      ];
      const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.22 });

      for (let index = 0; index < 52; index += 1) {
        const radius = 4 + Math.random() * 7;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const scale = 0.34 + Math.random() * 0.9;
        const cube = new THREE.Mesh(cubeGeometry, cubeMaterials[index % cubeMaterials.length]);
        cube.position.set(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.sin(phi) * Math.sin(theta) * 0.72,
          radius * Math.cos(phi) * 0.82,
        );
        cube.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        cube.scale.setScalar(scale);
        group.add(cube);

        const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        edges.position.copy(cube.position);
        edges.rotation.copy(cube.rotation);
        edges.scale.copy(cube.scale);
        group.add(edges);
      }

      const lineMaterial = new THREE.LineBasicMaterial({ color: 0x15a6d1, transparent: true, opacity: 0.34 });
      const linePoints = [
        new THREE.Vector3(-10, -1.2, 0),
        new THREE.Vector3(-4, 0.2, 0),
        new THREE.Vector3(0, -0.4, 0),
        new THREE.Vector3(4.5, 0.6, 0),
        new THREE.Vector3(10, -0.1, 0),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints), lineMaterial));

      let mouseX = 0;
      let mouseY = 0;
      const onPointerMove = (event: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        mouseX = (event.clientX - rect.left - rect.width / 2) / rect.width;
        mouseY = (event.clientY - rect.top - rect.height / 2) / rect.height;
      };
      const onResize = () => {
        if (!container.clientWidth || !container.clientHeight) {
          return;
        }
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
      };
      container.addEventListener("pointermove", onPointerMove);
      window.addEventListener("resize", onResize);

      const startTime = performance.now();
      let frame = 0;
      const animate = () => {
        if (disposed) {
          return;
        }
        frame = window.requestAnimationFrame(animate);
        const time = (performance.now() - startTime) / 1000;
        group.rotation.y += 0.018 * (mouseX * 1.8 - group.rotation.y) + 0.002;
        group.rotation.x += 0.018 * (mouseY * 1.2 - group.rotation.x);
        group.position.y = Math.sin(time * 0.55) * 0.32;
        renderer.render(scene, camera);
      };
      animate();

      cleanup = () => {
        window.cancelAnimationFrame(frame);
        container.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("resize", onResize);
        renderer.dispose();
        cubeGeometry.dispose();
        edgeGeometry.dispose();
        cubeMaterials.forEach((material) => material.dispose());
        edgeMaterial.dispose();
        lineMaterial.dispose();
        renderer.domElement.remove();
      };
    }

    void mountScene();
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return (
    <>
      <Head>
        <title>Inferoa | Inference-native Tokenmaxxing Agent Harness</title>
        <meta
          name="description"
          content="Inferoa is an Inference-native Tokenmaxxing Agent Harness for long-horizon coding work."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://inferoa.agentic-in.ai/" />
        <meta property="og:title" content="Inferoa | Inference-native Tokenmaxxing Agent Harness" />
        <meta
          property="og:description"
          content="Tokenmaxx long-horizon coding agents with prefix-cache discipline, context optimization, intelligent routing, and high-performance vLLM serving."
        />
        <meta property="og:image" content={shareImage} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Inferoa | Inference-native Tokenmaxxing Agent Harness" />
        <meta
          name="twitter:description"
          content="Tokenmaxx long-horizon coding agents with prefix-cache discipline, context optimization, intelligent routing, and high-performance vLLM serving."
        />
        <meta name="twitter:image" content={shareImage} />
      </Head>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          <div className={styles.uiLayer}>
            <header className={styles.edgeNav}>
              <Link className={styles.logoBlock} to="/" aria-label="Inferoa home">
                <span className={styles.promptMark}>›_</span>
                <span>Infer</span><strong>oa</strong>
              </Link>
              <nav className={styles.mainNav} aria-label="Primary">
                <Link to="/docs/intro">Docs</Link>
                <Link to="/blog/announcing-inferoa">Blog</Link>
              </nav>
              <a className={styles.githubLink} href="https://github.com/agentic-in/inferoa">GitHub</a>
            </header>

            <div className={styles.heroCenter}>
              <h1 className={styles.heroStatement} aria-label="Inference-native tokenmaxxing agent harness">
                <span className={styles.heroLine}>
                  <span className={`${styles.heroPill} ${styles.heroPillInference}`}>Inference-native</span>
                </span>
                <span className={styles.heroLine}>
                  <span className={styles.heroWordBlock}>Tokenmaxxing</span>
                </span>
                <span className={styles.heroLine}>
                  <span className={styles.heroWordBlock}>Agent</span>
                  <span className={`${styles.heroPill} ${styles.heroPillHarness}`}>Harness</span>
                </span>
              </h1>
            </div>

            <footer className={`${styles.edgeNav} ${styles.bottomNav}`}>
              <div className={styles.contactBlock}>
                <span className={styles.sayHi}>Init</span>
                <Link className={styles.emailLink} to="/docs/quickstart">
                  inferoa.agentic-in.ai/start
                </Link>
              </div>
            </footer>
          </div>
        </section>

        <section className={styles.problem}>
          <div className={styles.sectionInner}>
            <span className={styles.sectionKicker}>The mismatch</span>
            <h1>The Gap</h1>
            <p>
              Most agents, routers, and inference engines are designed as{" "}
              <strong>separate layers</strong>. The agent keeps sending{" "}
              <strong>generic chat traffic</strong>, while{" "}
              <strong>prefix cache stability</strong>,{" "}
              <strong>route choice</strong>, <strong>serving behavior</strong>,
              and <strong>context pressure</strong> stay invisible. Inferoa
              brings those <strong>tokenmaxxing surfaces</strong> into the
              agent harness itself.
            </p>
          </div>
        </section>

        <section className={styles.modules}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionKicker}>Tokenmaxxing surfaces</span>
              <h2>The Loop</h2>
            </div>
            <div className={styles.moduleGrid}>
              {modules.map(([number, title, body]) => (
                <article className={styles.moduleCard} key={title}>
                  <span>{number}</span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.mission}>
          <div className={styles.sectionInner}>
            <div className={styles.missionCopy}>
              <span className={styles.sectionKicker}>Mission</span>
              <h2>Tokenmaxx the agent path.</h2>
              <p>
                <strong>Inferoa</strong> starts with coding because coding
                exposes <strong>long-horizon pressure</strong> clearly: large
                repos, changing goals, tool failures, repeated model calls,
                context limits, and proof through tests. The goal is to
                co-design the harness and inference stack so every turn spends{" "}
                <strong>context, cache, route choice, and serving capacity</strong>{" "}
                more deliberately.
              </p>
            </div>
            <div className={styles.loopCards} aria-label="Inference loop design points">
              <article>
                <span>01</span>
                <strong>Prefix-cache discipline</strong>
                <p>Stable prompt epochs, bounded context, and fixed tool schemas keep long sessions warm.</p>
              </article>
              <article>
                <span>02</span>
                <strong>Context is optimized</strong>
                <p>Compression, graph-shaped context, and bounded tool output select evidence instead of pasting everything.</p>
              </article>
              <article>
                <span>03</span>
                <strong>Routing and serving are native</strong>
                <p>vLLM SR chooses paths while vLLM Engine supplies high-throughput, memory-efficient serving.</p>
              </article>
            </div>
          </div>
        </section>

        <section className={styles.sessions}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionKicker}>Quick Look</span>
              <h2>Inside a Session</h2>
            </div>
            <div className={styles.sessionCarousel} aria-label="Inferoa session screenshots">
              <div className={styles.sessionTrack}>
                {[0, 1].map((copyIndex) =>
                  sessionScreens.map((screen, index) => (
                    <article
                      className={styles.sessionCard}
                      key={`${copyIndex}-${screen.title}`}
                      aria-hidden={copyIndex === 1 ? "true" : undefined}
                    >
                      <div className={styles.sessionCardHeader}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <h3>{screen.title}</h3>
                          <p>{screen.body}</p>
                        </div>
                      </div>
                      <img src={screen.image} alt={`Inferoa ${screen.title} screen`} loading="lazy" />
                    </article>
                  )),
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.ecosystem}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionKicker}>Built on vLLM Ecosystem</span>
              <h2>Tokenmaxxing on the vLLM Stack</h2>
            </div>
            <div className={styles.ecosystemGrid}>
              {ecosystem.map((item) => (
                <a className={styles.ecosystemCard} href={item.href} key={item.name}>
                  {item.img ? <img src={item.img} alt={item.name} /> : <strong>{item.name}</strong>}
                  <p>{item.body}</p>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.stack}>
          <div className={styles.sectionInner}>
            <span className={styles.sectionKicker}>Cross-stack path</span>
            <div className={styles.stackLayout}>
              <h2>Across the Tokenmaxxing Stack</h2>
              <ol className={styles.stackFlow}>
                {stackFlow.map(([title, body], index) => (
                  <li key={title}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{title}</strong>
                    <em>{body}</em>
                    {index < stackFlow.length - 1 ? <b aria-hidden="true">→</b> : null}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
