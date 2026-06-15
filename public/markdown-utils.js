(function () {
  if (window.marked && !window.__devHelperMarkedConfigured) {
    if (typeof window.marked.use === "function") {
      window.marked.use({ gfm: true, breaks: false });
    } else if (typeof window.marked.setOptions === "function") {
      window.marked.setOptions({ gfm: true, breaks: false });
    }
    window.__devHelperMarkedConfigured = true;
  }

  function unwrapDocumentCodeFence(md) {
    if (window.DevHelperMermaid?.unwrapDocumentCodeFence) {
      return window.DevHelperMermaid.unwrapDocumentCodeFence(md);
    }
    const text = String(md || "").trim();
    if (!text.startsWith("```")) return text;
    const match = text.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
    return match ? String(match[1] || "").trim() : text;
  }

  function prepareMarkdown(md) {
    const unwrapped = unwrapDocumentCodeFence(md);
    return window.DevHelperMermaid?.sanitizeMarkdown
      ? window.DevHelperMermaid.sanitizeMarkdown(unwrapped)
      : unwrapped;
  }

  function parseMarkdown(md) {
    if (!md || !window.marked) return "";
    return window.marked.parse(String(prepareMarkdown(md)));
  }

  function looksLikeMarkdownDocument(text) {
    const sample = String(text || "").trim();
    if (!sample) return false;
    return (
      /^#{1,3}\s/m.test(sample) ||
      /^\|.+\|/m.test(sample) ||
      /^[-*]\s+\S/m.test(sample) ||
      /^\d+\.\s+\S/m.test(sample)
    );
  }

  function isDocLevelCodeBlock(code) {
    const lang = (code.className || "").replace("language-", "").toLowerCase();
    return !lang || lang === "markdown" || lang === "md" || lang === "text";
  }

  async function repairDocLevelCodeFence(container) {
    if (!container || container.dataset.docFenceRepaired === "1") return false;
    const pres = container.querySelectorAll(":scope > pre");
    if (pres.length !== 1) return false;
    const pre = pres[0];
    const code = pre.querySelector("code");
    if (!code || !isDocLevelCodeBlock(code)) return false;
    const raw = code.textContent || "";
    if (!looksLikeMarkdownDocument(raw)) return false;
    container.dataset.docFenceRepaired = "1";
    container.innerHTML = parseMarkdown(raw);
    return true;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function sanitizeMermaid(source) {
    if (window.DevHelperMermaid?.sanitize) {
      return window.DevHelperMermaid.sanitize(source);
    }
    return source;
  }

  function isValidMermaid(source) {
    if (window.DevHelperMermaid?.isValidMermaidSource) {
      return window.DevHelperMermaid.isValidMermaidSource(source);
    }
    return /^(graph|flowchart|sequenceDiagram|erDiagram|classDiagram)/im.test(String(source || "").trim());
  }

  function looksLikeCode(source) {
    return window.DevHelperMermaid?.looksLikeCodeNotMermaid?.(source) || false;
  }

  function inferLang(source) {
    return window.DevHelperMermaid?.inferCodeLang?.(source) || "text";
  }

  function cleanupMermaidRenderArtifacts(id) {
    for (const key of [id, `d${id}`]) {
      const el = document.getElementById(key);
      if (el) el.remove();
    }
    document.querySelectorAll(`[data-processed="${id}"]`).forEach((el) => {
      if (el.parentElement === document.body) el.remove();
    });
  }

  function cleanupStrayMermaidArtifacts() {
    document.querySelectorAll("body > .mermaid-sandbox").forEach((el) => el.remove());
    document.querySelectorAll('body > div[id^="mermaid-"], body > div[id^="dmermaid-"]').forEach((el) => {
      if (el.classList.contains("mermaid-sandbox") || el.parentElement === document.body) el.remove();
    });
  }

  function svgLooksLikeMermaidError(svg) {
    return /syntax error in text|error in text|parse error/i.test(String(svg || ""));
  }

  function finalizeMermaidNode(node) {
    if (!node) return;
    node.classList.remove("mermaid-error");
    node.classList.add("mermaid-rendered");
    node.style.removeProperty("display");
    node.style.removeProperty("visibility");
    node.style.removeProperty("opacity");
    node.removeAttribute("data-processed");
    const svg = node.querySelector("svg");
    if (svg) {
      svg.style.maxWidth = "100%";
      svg.style.height = "auto";
      svg.removeAttribute("style");
      svg.style.maxWidth = "100%";
      svg.style.height = "auto";
    }
  }

  function showMermaidFallback(node, source, message) {
    node.classList.add("mermaid-error");
    node.style.removeProperty("display");
    node.innerHTML =
      `<div class="mermaid-fallback-wrap">` +
      `<p class="mermaid-fallback-note">${escapeHtml(message)}</p>` +
      `<details class="mermaid-fallback-details">` +
      `<summary>View diagram source</summary>` +
      `<pre class="mermaid-fallback"><code>${escapeHtml(source)}</code></pre>` +
      `</details></div>`;
  }

  function replaceWithCodeBlock(node, source) {
    const lang = inferLang(source);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = `language-${lang}`;
    code.textContent = source;
    pre.appendChild(code);
    const wrap = document.createElement("div");
    wrap.className = "mermaid-code-fallback";
    wrap.appendChild(pre);
    node.replaceWith(wrap);
  }

  function isVideoUrl(href) {
    return /\.(webm|mp4|mov|m4v)(\?|#|$)/i.test(href) || /\/videos\//i.test(href);
  }

  function normalizeMediaSrc(href) {
    const raw = String(href || "").trim();
    if (!raw) return raw;
    if (/^https?:\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) {
      return raw;
    }
    if (raw.startsWith("/")) return raw;
    return `/${raw.replace(/^\.?\//, "")}`;
  }

  function enhanceMediaLinks(container) {
    container.querySelectorAll("a[href]").forEach((anchor) => {
      const href = normalizeMediaSrc(anchor.getAttribute("href") || "");
      if (!href) return;
      anchor.setAttribute("href", href);

      if (isVideoUrl(href)) {
        const label = (anchor.textContent || "Screen recording").trim();
        const figure = document.createElement("figure");
        figure.className = "markdown-video";
        const video = document.createElement("video");
        video.src = href;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        const caption = document.createElement("figcaption");
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = label || "Open recording";
        caption.appendChild(link);
        figure.appendChild(video);
        figure.appendChild(caption);
        anchor.replaceWith(figure);
        return;
      }

      const imgChild = anchor.querySelector("img");
      if (imgChild) {
        const src = normalizeMediaSrc(imgChild.getAttribute("src") || href);
        imgChild.src = src;
        imgChild.loading = "lazy";
        imgChild.decoding = "async";
        if (!imgChild.getAttribute("alt")) imgChild.setAttribute("alt", anchor.textContent || "Screenshot");
      }
    });

    container.querySelectorAll("img[src]").forEach((img) => {
      const src = normalizeMediaSrc(img.getAttribute("src") || "");
      if (src) img.setAttribute("src", src);
      img.loading = "lazy";
      img.decoding = "async";
      if (!img.getAttribute("alt")) img.setAttribute("alt", "Screenshot");
      img.onerror = function onImgError() {
        if (!this.dataset.fallbackTried) {
          this.dataset.fallbackTried = "1";
          const path = normalizeMediaSrc(this.getAttribute("src") || "");
          if (path && path !== this.src) this.src = path;
        }
      };
    });

    container.querySelectorAll("video[src]").forEach((video) => {
      const src = normalizeMediaSrc(video.getAttribute("src") || "");
      if (src) video.setAttribute("src", src);
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
    });
  }

  async function renderMermaidNodeWithFallback(node, source, idx) {
    const id = `mermaid-${Date.now()}-${idx}`;
    try {
      const { svg } = await window.mermaid.render(id, source);
      cleanupMermaidRenderArtifacts(id);

      if (!svg || svgLooksLikeMermaidError(svg)) {
        showMermaidFallback(node, source, "Diagram could not be rendered.");
        return;
      }

      node.innerHTML = svg;
      finalizeMermaidNode(node);
    } catch {
      cleanupMermaidRenderArtifacts(id);
      showMermaidFallback(node, source, "Diagram could not be rendered.");
    }
  }

  async function renderMermaidNodes(container) {
    const mermaidNodes = container.querySelectorAll(".mermaid:not(.mermaid-rendered)");
    if (!mermaidNodes.length || !window.mermaid) return;

    let idx = 0;
    for (const node of mermaidNodes) {
      const raw = node.dataset.mermaidSource || node.textContent || "";
      const source = sanitizeMermaid(raw);
      node.textContent = source;
      node.dataset.mermaidSource = raw;
      node.style.removeProperty("display");

      if (!isValidMermaid(source)) {
        if (looksLikeCode(source)) {
          replaceWithCodeBlock(node, source);
        } else {
          showMermaidFallback(node, source, "This block is not valid Mermaid diagram syntax.");
        }
        continue;
      }

      await renderMermaidNodeWithFallback(node, source, idx++);
    }

    cleanupStrayMermaidArtifacts();
  }

  function appendMediaIfMissing(md, screenshots = [], videos = []) {
    let out = String(md || "").trim();
    const hasImages = /!\[[^\]]*\]\([^)]+\)/.test(out);
    const hasVideos =
      /\[▶[^\]]*\]\([^)]+\)/.test(out) ||
      /\[[^\]]*\]\([^)]+\.(webm|mp4|mov|m4v)(\?|#|$)/i.test(out) ||
      /\/videos\//i.test(out);

    if (screenshots.length && !hasImages) {
      const block = screenshots
        .map((s) => `**${s.label}**\n\n![${s.label}](${normalizeMediaSrc(s.url)})`)
        .join("\n\n");
      out += `\n\n## Screenshots from live panel\n\n${block}`;
    }

    if (videos.length && !hasVideos) {
      const block = videos
        .map((v) => `[▶ ${v.label}](${normalizeMediaSrc(v.url)})`)
        .join("\n\n");
      out += `\n\n## Screen recordings\n\n${block}`;
    }

    return out;
  }

  async function enhanceMarkdown(container) {
    if (!container) return;

    if (await repairDocLevelCodeFence(container)) {
      await enhanceMarkdown(container);
      return;
    }

    container.querySelectorAll("pre code").forEach((code) => {
      const lang = (code.className || "").replace("language-", "").toLowerCase();
      const pre = code.parentElement;
      if (!pre || pre.tagName !== "PRE") return;

      if (lang === "mermaid") {
        const raw = code.textContent || "";
        const source = sanitizeMermaid(raw);

        if (!isValidMermaid(source)) {
          const altLang = looksLikeCode(source) ? inferLang(source) : "text";
          code.className = `language-${altLang}`;
          code.textContent = source;
          if (!looksLikeCode(source)) {
            const note = document.createElement("p");
            note.className = "mermaid-invalid-note";
            note.textContent = "Not valid Mermaid syntax — shown as plain text.";
            pre.insertAdjacentElement("afterend", note);
          }
          return;
        }

        const div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = source;
        pre.replaceWith(div);
        return;
      }

      code.style.background = "transparent";
      code.style.color = "inherit";
      code.style.border = "none";
      code.style.padding = "0";
    });

    await renderMermaidNodes(container);
    enhanceMediaLinks(container);
  }

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "loose",
    });
  }

  window.DevHelperMarkdown = {
    parse: parseMarkdown,
    enhance: enhanceMarkdown,
    appendMediaIfMissing,
    normalizeMediaSrc,
    unwrapDocumentCodeFence,
    prepareMarkdown,
  };
})();
