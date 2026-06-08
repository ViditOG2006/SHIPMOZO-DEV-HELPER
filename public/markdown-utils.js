(function () {
  function parseMarkdown(md) {
    if (!md || !window.marked) return "";
    return window.marked.parse(String(md));
  }

  function enhanceMarkdown(container) {
    if (!container) return;

    container.querySelectorAll("pre code").forEach((code) => {
      const lang = (code.className || "").replace("language-", "").toLowerCase();
      const pre = code.parentElement;
      if (!pre || pre.tagName !== "PRE") return;

      if (lang === "mermaid") {
        const div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = code.textContent || "";
        pre.replaceWith(div);
        return;
      }

      code.style.background = "transparent";
      code.style.color = "inherit";
      code.style.border = "none";
      code.style.padding = "0";
    });

    const mermaidNodes = container.querySelectorAll(".mermaid");
    if (mermaidNodes.length && window.mermaid) {
      try {
        window.mermaid.run({ nodes: mermaidNodes, suppressErrors: true });
      } catch {
        /* keep source visible */
      }
    }
  }

  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "loose",
    });
  }

  window.DevHelperMarkdown = { parse: parseMarkdown, enhance: enhanceMarkdown };
})();
