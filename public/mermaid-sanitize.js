(function () {
  const MERMAID_BLOCK_RE = /```mermaid\s*\n([\s\S]*?)```/gi;

  const DOC_FENCE_RE = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i;

  function unwrapDocumentCodeFence(md) {
    const text = String(md || "").trim();
    if (!text.startsWith("```")) return text;
    const match = text.match(DOC_FENCE_RE);
    if (!match) return text;
    const openLine = text.split(/\r?\n/, 1)[0].trim();
    const lang = openLine.replace(/^```/, "").trim().toLowerCase();
    if (lang && lang !== "markdown" && lang !== "md") return text;
    return String(match[1] || "").trim();
  }

  const MERMAID_DIAGRAM_RE =
    /^(?:graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie\s|gitGraph|journey|timeline|mindmap|quadrantChart|requirementDiagram|C4Context|block-beta|sankey-beta|xychart-beta|architecture-beta)/im;

  function isErRelationshipLine(trimmed) {
    return /\|\|--/.test(trimmed) || /}o--|o\{--|}\|--/.test(trimmed);
  }

  function isErAttributeLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "{" || trimmed === "}") return false;
    if (trimmed.startsWith("erDiagram") || isErRelationshipLine(trimmed)) return false;
    return /^\s+[A-Za-z_][\w]*\s+\S+/.test(line);
  }

  function sanitizeErDiagramLine(line) {
    if (!isErAttributeLine(line)) return line;

    let out = line
      .replace(/\s+PK\s*,\s*FK\s*$/i, "")
      .replace(/\s+FK\s*,\s*PK\s*$/i, "")
      .replace(/\s+PK\s*$/i, "")
      .replace(/\s+FK\s*$/i, "");

    out = out.replace(/^(\s*)enum\s+/i, "$1string ");
    out = out.replace(/^(\s*)timestamp\s+/i, "$1string ");
    out = out.replace(/^(\s*)datetime\s+/i, "$1string ");
    out = out.replace(/^(\s*)json\s+/i, "$1string ");
    out = out.replace(/^(\s*)uuid\s+/i, "$1string ");

    return out;
  }

  function isValidMermaidSource(source) {
    const text = String(source || "").trim();
    if (!text) return false;
    return MERMAID_DIAGRAM_RE.test(text);
  }

  function looksLikeCodeNotMermaid(source) {
    const text = String(source || "").trim();
    if (!text) return false;
    if (/^\s*(export\s+)?(interface|type|enum|class)\b/m.test(text)) return true;
    if (/^\s*import\s+[\w{*]/m.test(text)) return true;
    if (/^\s*(const|let|var)\s+\w+\s*[:=]/m.test(text)) return true;
    if (/^\s*function\s+\w+/m.test(text)) return true;
    if (/^\s*{\s*"/m.test(text)) return true;
    if (
      !isValidMermaidSource(text) &&
      /^\s*[\w.]+\s*:\s*[\w<>\[\]|&?]+/m.test(text) &&
      /[{;}]/.test(text)
    ) {
      return true;
    }
    return false;
  }

  function inferCodeLang(source) {
    const text = String(source || "").trim();
    if (/^\s*{\s*"/m.test(text)) return "json";
    if (/^\s*(export\s+)?(interface|type|enum)\b/m.test(text)) return "typescript";
    if (/^\s*class\s+\w+/m.test(text)) return "typescript";
    return "text";
  }

  function sanitizeSubgraphLine(line) {
    const m = line.match(/^(\s*)subgraph\s+(\S(?:.*\S)?)\s*$/i);
    if (!m) return line;
    const indent = m[1];
    const title = m[2].trim();
    if (title.includes("[") || title.startsWith('"')) return line;
    if (!/\s/.test(title) && /^[A-Za-z_]\w*$/.test(title)) return line;
    const id = title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "subgraph";
    const safeTitle = title.replace(/"/g, "#quot;");
    return `${indent}subgraph ${id} [${safeTitle}]`;
  }

  function sanitizeFlowchartColonNodes(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) return line;
    if (/^(subgraph|end|style|classDef|class|linkStyle|click)\b/i.test(trimmed)) return line;

    let out = line;

    out = out.replace(/(\b[A-Za-z_]\w*)\([^)]*\)\s*:\s*(.+?)\s*$/g, (_, id, label) => {
      return `${id}[${quoteMermaidLabel(label.trim())}]`;
    });

    out = out.replace(/(\b[A-Za-z_]\w*)\(([^)"]+)\)/g, (match, id, inner) => {
      if (/^(style|classDef|class|linkStyle|click)\b/i.test(id)) return match;
      const t = inner.trim();
      if (/^(service|queue|client|api|gateway|ui)$/i.test(t)) return match;
      if (/^[A-Za-z_][\w]*$/.test(t)) return match;
      if (/\s/.test(t) || labelNeedsQuoting(t)) return `${id}(${quoteMermaidLabel(t)})`;
      return match;
    });

    return out;
  }

  function sanitizeFlowchartNodeLabels(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) return line;
    if (/^(style|classDef|class|linkStyle|click)\b/i.test(trimmed)) return line;

    let out = line;

    out = out.replace(/(\b[A-Za-z_]\w*)\[([^\]"]+)\]/g, (match, id, label) =>
      labelNeedsQuoting(label) ? `${id}[${quoteMermaidLabel(label)}]` : match
    );

    out = out.replace(/(\b[A-Za-z_]\w*)\{([^}"]+)\}/g, (match, id, label) =>
      labelNeedsQuoting(label) ? `${id}{${quoteMermaidLabel(label)}}` : match
    );

    out = out.replace(/(\b[A-Za-z_]\w*)\(([^)"]+)\)/g, (match, id, label) => {
      if (/^(style|classDef|class|linkStyle|click)\b/i.test(id)) return match;
      return labelNeedsQuoting(label) ? `${id}(${quoteMermaidLabel(label)})` : match;
    });

    return out;
  }

  function labelNeedsQuoting(label) {
    const t = String(label || "").trim();
    if (!t || /^".*"$/.test(t)) return false;
    return /[()[\]{}#&;:?]/.test(t);
  }

  function quoteMermaidLabel(label) {
    const t = String(label || "").trim();
    if (/^".*"$/.test(t)) return t;
    return `"${t.replace(/"/g, "#quot;")}"`;
  }

  function sanitizeFlowchartSource(source) {
    const text = String(source || "").trim();
    if (!/^(?:graph|flowchart)\s/im.test(text)) return text;
    return text
      .split("\n")
      .map((line) => sanitizeFlowchartNodeLabels(sanitizeFlowchartColonNodes(sanitizeSubgraphLine(line))))
      .join("\n");
  }

  function sanitize(source) {
    const text = String(source || "").trim();
    if (!text) return text;
    if (/^erDiagram\b/im.test(text)) {
      return text
        .split("\n")
        .map((line) => sanitizeErDiagramLine(line))
        .join("\n");
    }
    if (/^(?:graph|flowchart)\s/im.test(text)) {
      return sanitizeFlowchartSource(text);
    }
    return text;
  }

  function sanitizeMarkdown(md) {
    return String(unwrapDocumentCodeFence(md) || "").replace(MERMAID_BLOCK_RE, (match, body) => {
      const trimmed = String(body || "").trim();
      if (!trimmed) return match;
      if (looksLikeCodeNotMermaid(trimmed) && !isValidMermaidSource(trimmed)) {
        const lang = inferCodeLang(trimmed);
        return `\`\`\`${lang}\n${String(body).trimEnd()}\n\`\`\``;
      }
      return `\`\`\`mermaid\n${sanitize(body)}\n\`\`\``;
    });
  }

  window.DevHelperMermaid = {
    sanitize,
    sanitizeMarkdown,
    sanitizeFlowchartSource,
    sanitizeSubgraphLine,
    sanitizeFlowchartColonNodes,
    labelNeedsQuoting,
    quoteMermaidLabel,
    unwrapDocumentCodeFence,
    isValidMermaidSource,
    looksLikeCodeNotMermaid,
    inferCodeLang,
  };
})();
