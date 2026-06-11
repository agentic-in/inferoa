import { useEffect, useRef, useState } from "react";
import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./index.module.css";

const modules = [
  ["01", "Loop Engineering", "Design the objective, feedback, verifier, memory, tools, and stop condition instead of hand-steering every prompt."],
  ["02", "Tokenmaxxing", "Keep each turn cache-aware, context-bounded, route-conscious, and measurable as the loop grows."],
  ["03", "Inference-native runtime", "Expose context windows, prefix cache, model paths, endpoint signals, and serving constraints to the loop."],
  ["04", "Proof-oriented loops", "Use plans, tests, tool evidence, research metrics, verification, decisions, and completion reports to decide when to stop."],
];

const stackFlow = [
  ["Loop Mode", "loop tasks + verification"],
  ["Agent Harness", "sessions, tools, evidence"],
  ["Tokenmaxxing", "prefix, context, routing"],
  ["vLLM Serving", "Engine + Omni"],
];

const sessionDemos = [
  {
    title: "Welcome",
    body: "A restrained entry point for the configured model, workspace, and core commands.",
    image: "/gif/welcome.gif",
  },
  {
    title: "Loop Mode",
    body: "Run /loop to start a long-horizon recursive loop with loop tasks, attempts, evidence, and decisions.",
    image: "/gif/loop.gif",
  },
  {
    title: "Plan Mode",
    body: "Ambiguous scope becomes an inspectable plan before execution starts.",
    image: "/gif/plan.gif",
  },
  {
    title: "Research Loops",
    body: "Benchmark runs, failures, fixes, and metrics stay inside the loop decision flow.",
    image: "/gif/research.gif",
  },
];

export default function Home(): JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [installCopied, setInstallCopied] = useState(false);
  const vllmLogo = useBaseUrl("/img/vllm-logo-text-light.png");
  const srLogo = useBaseUrl("/img/vllm-sr-logo.light.png");
  const omniLogo = useBaseUrl("/img/vllm-omni-logo.png");
  const shareImage = "https://inferoa.agentic-in.ai/img/inferoa-line-hero.png";
  const installCommand = "npm install -g inferoa@dev";
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

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = installCommand;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setInstallCopied(true);
    window.setTimeout(() => setInstallCopied(false), 1400);
  }

  return (
    <>
      <Head>
        <title>Inferoa | Inference-native Tokenmaxxing Agent Harness for Loop Engineering</title>
        <meta
          name="description"
          content="Inferoa is an Inference-native Tokenmaxxing Agent Harness for Loop Engineering, built around vLLM serving, routing, context optimization, and prefix-cache discipline."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://inferoa.agentic-in.ai/" />
        <meta property="og:title" content="Inferoa | Inference-native Tokenmaxxing Agent Harness for Loop Engineering" />
        <meta
          property="og:description"
          content="Run recursive long-horizon loops while tokenmaxxing prefix cache, context optimization, vLLM Semantic Router, vLLM serving, Omni, RTK, and CodeGraph."
        />
        <meta property="og:image" content={shareImage} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Inferoa | Inference-native Tokenmaxxing Agent Harness for Loop Engineering" />
        <meta
          name="twitter:description"
          content="Run recursive long-horizon loops while tokenmaxxing prefix cache, context optimization, vLLM Semantic Router, vLLM serving, Omni, RTK, and CodeGraph."
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
              <h1 className={styles.heroStatement} aria-label="Inference-native tokenmaxxing agent harness for loop engineering">
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
              <div className={styles.heroTags} aria-label="Inferoa positioning">
                <span className={styles.heroTag}>Inference-native</span>
                <span className={styles.heroTag}>Tokenmaxxing</span>
                <span className={styles.heroTag}>Loop Engineering</span>
              </div>
            </div>

            <footer className={`${styles.edgeNav} ${styles.bottomNav}`}>
              <div className={styles.installBlock}>
                <span className={styles.installLabel}>{installCopied ? "Copied" : "Install latest dev"}</span>
                <button className={styles.installCommand} type="button" onClick={copyInstallCommand} aria-label={`Copy ${installCommand}`}>
                  <span className={styles.promptMark}>$</span>
                  <code>{installCommand}</code>
                </button>
              </div>
            </footer>
          </div>
        </section>

        <section className={styles.problem}>
          <div className={styles.sectionInner}>
            <span className={styles.sectionKicker}>Why loops break</span>
            <h1>Loops fail when inference is invisible.</h1>
            <p>
              Loop engineering works when a model can run against{" "}
              <strong>goals, rubrics, feedback, memory, and verification</strong>.
              But every loop is also an <strong>inference workload</strong>:
              prefixes drift, <strong>cache reuse</strong> collapses, stale
              evidence fills <strong>context</strong>, <strong>routing</strong>{" "}
              gets harder, and <strong>serving constraints</strong> start to
              shape the result. Inferoa keeps those{" "}
              <strong>tokenmaxxing surfaces</strong> inside the harness.
            </p>
          </div>
        </section>

        <section className={styles.modules}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionKicker}>Three words, one runtime</span>
              <h2>Loop Engineering needs Tokenmaxxing.</h2>
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
              <h2>Design loops with inference feedback.</h2>
              <p>
                <strong>Inferoa</strong> starts with <strong>coding</strong>{" "}
                because coding exposes <strong>loop pressure</strong> clearly:
                changing goals, tool failures, repeated model calls, context
                limits, memory needs, verifier signals, and proof through
                tests. The goal is to co-design the{" "}
                <strong>agent harness, loop controller, and inference stack</strong>{" "}
                so every turn spends{" "}
                <strong>context, cache, route choice, and serving capacity</strong>{" "}
                deliberately.
              </p>
            </div>
            <div className={styles.loopCards} aria-label="Inference loop design points">
              <article>
                <span>01</span>
                <strong>Loop and rubric feedback</strong>
                <p>One durable outcome expands through loop tasks, evidence, decisions, recovery, and completion reports.</p>
              </article>
              <article>
                <span>02</span>
                <strong>Verifier-ready evidence</strong>
                <p>Plans, tests, tool results, and research metrics give the loop concrete feedback to improve against.</p>
              </article>
              <article>
                <span>03</span>
                <strong>Inference stays visible</strong>
                <p>Prefix cache, context pressure, routing, multimodal endpoints, and serving constraints stay in the loop.</p>
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
            <div className={styles.sessionGrid} aria-label="Inferoa session GIF demos">
              {sessionDemos.map((screen, index) => (
                <article className={styles.sessionCard} key={screen.title}>
                  <div className={styles.sessionCardHeader}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>{screen.title}</h3>
                      <p>{screen.body}</p>
                    </div>
                  </div>
                  <img src={screen.image} alt={`Inferoa ${screen.title} session demo`} loading="lazy" />
                </article>
              ))}
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

        <footer className={styles.siteFooter}>
          <div className={styles.siteFooterInner}>
            <div className={styles.siteFooterBrand}>
              <Link className={styles.siteFooterLogo} to="/" aria-label="Inferoa home">
                <span className={styles.promptMark}>›_</span>
                <span>Infer</span><strong>oa</strong>
              </Link>
              <p>Inference-native Tokenmaxxing Agent Harness for Loop Engineering.</p>
            </div>
            <nav className={styles.siteFooterLinks} aria-label="Footer">
              <div>
                <h2>Product</h2>
                <Link to="/docs/intro">Docs</Link>
                <Link to="/blog/announcing-inferoa">Announcement</Link>
              </div>
              <div>
                <h2>Code</h2>
                <a href="https://github.com/agentic-in/inferoa">GitHub</a>
                <a href="https://www.npmjs.com/package/inferoa">npm</a>
              </div>
            </nav>
            <div className={styles.siteFooterBottom}>
              <code>npm install -g inferoa</code>
              <span>Copyright © {new Date().getFullYear()} Inferoa contributors.</span>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}
