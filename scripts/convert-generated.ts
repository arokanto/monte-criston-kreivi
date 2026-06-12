const rootDir = new URL("../", import.meta.url);
const oebpsDir = new URL("../epub-source/OEBPS/", import.meta.url);
const opfFile = new URL("content.opf", oebpsDir);
const htmlOutDir = new URL("../generated-html/", import.meta.url);
const textOutDir = new URL("../generated-text/", import.meta.url);

const bookSlug = "monte-criston-kreivi";
const bookTitle = "Monte-Criston kreivi";
const cssFiles = ["epub-layout.css", "book.css"];
const imageFilePattern = /\.(png|jpe?g|gif|svg|webp)$/i;

type BodyParts = {
  attrs: string;
  html: string;
  lang: string;
  title: string;
};

type OpfSpine = {
  manifest: Map<string, string>;
  hrefs: string[];
};

await main();

async function main(): Promise<void> {
  await resetDir(htmlOutDir);
  await resetDir(textOutDir);

  const css = await readCss();
  const opf = await readOpfSpine();
  const xhtmlFiles = await listXhtmlFiles();

  const htmlByHref = new Map<string, BodyParts>();

  for (const href of xhtmlFiles) {
    const source = await Deno.readTextFile(new URL(href, oebpsDir));
    const parts = convertXhtml(source, "multi");
    htmlByHref.set(href, parts);

    const htmlName = replaceExtension(href, ".html");
    const textName = replaceExtension(href, ".txt");

    await Deno.writeTextFile(new URL(htmlName, htmlOutDir), renderHtmlDocument(parts, css));
    await Deno.writeTextFile(new URL(textName, textOutDir), htmlToText(parts.html) + "\n");
  }

  await copyImageAssets();
  await writeCombinedOutputs(opf, css);

  console.log(`Wrote ${xhtmlFiles.length} HTML files to ${displayPath(htmlOutDir)}`);
  console.log(`Wrote ${xhtmlFiles.length} text files to ${displayPath(textOutDir)}`);
  console.log(`Wrote combined master files:`);
  console.log(`  ${displayPath(new URL(`${bookSlug}.html`, htmlOutDir))}`);
  console.log(`  ${displayPath(new URL(`${bookSlug}.txt`, textOutDir))}`);
}

async function resetDir(dir: URL): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  await Deno.mkdir(dir, { recursive: true });
}

async function readCss(): Promise<string> {
  const chunks: string[] = [];
  for (const file of cssFiles) {
    chunks.push(`/* ${file} */\n${await Deno.readTextFile(new URL(file, oebpsDir))}`);
  }
  return chunks.join("\n\n");
}

async function readOpfSpine(): Promise<OpfSpine> {
  const opf = await Deno.readTextFile(opfFile);
  const manifest = new Map<string, string>();

  for (const match of opf.matchAll(/<item\b([^>]+)>/g)) {
    const attrs = match[1];
    const id = getAttribute(attrs, "id");
    const href = getAttribute(attrs, "href");
    const mediaType = getAttribute(attrs, "media-type");
    if (id && href && mediaType === "application/xhtml+xml") {
      manifest.set(id, href);
    }
  }

  const hrefs: string[] = [];
  for (const match of opf.matchAll(/<itemref\b([^>]+)>/g)) {
    const idref = getAttribute(match[1], "idref");
    const href = idref ? manifest.get(idref) : undefined;
    if (href) {
      hrefs.push(href);
    }
  }

  return { manifest, hrefs };
}

async function listXhtmlFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(oebpsDir)) {
    if (entry.isFile && entry.name.endsWith(".xhtml")) {
      files.push(entry.name);
    }
  }
  return files.sort(compareContentNames);
}

async function copyImageAssets(): Promise<void> {
  for await (const entry of Deno.readDir(oebpsDir)) {
    if (entry.isFile && imageFilePattern.test(entry.name)) {
      await Deno.copyFile(new URL(entry.name, oebpsDir), new URL(entry.name, htmlOutDir));
    }
  }
}

async function writeCombinedOutputs(opf: OpfSpine, css: string): Promise<void> {
  const bodyChunks: string[] = [];
  for (const href of opf.hrefs) {
    if (href === "wrap0000.xhtml") {
      continue;
    }
    const source = await Deno.readTextFile(new URL(href, oebpsDir));
    const parts = convertXhtml(source, "single");
    bodyChunks.push(`<!-- ${href} -->\n${parts.html}`);
  }

  const bodyHtml = bodyChunks.join("\n\n");
  const masterHtml = renderHtmlDocument({
    attrs: "",
    html: bodyHtml,
    lang: "fi",
    title: bookTitle,
  }, css);

  await Deno.writeTextFile(new URL(`${bookSlug}.html`, htmlOutDir), masterHtml);
  await Deno.writeTextFile(new URL(`${bookSlug}.txt`, textOutDir), htmlToText(bodyHtml) + "\n");
}

function convertXhtml(source: string, linkMode: "multi" | "single"): BodyParts {
  const title = decodeEntities(source.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? bookTitle);
  const htmlAttrs = source.match(/<html\b([^>]*)>/i)?.[1] ?? "";
  const bodyMatch = source.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) {
    throw new Error("Could not find XHTML body.");
  }

  return {
    attrs: transformBodyAttributes(bodyMatch[1]),
    html: transformBodyHtml(bodyMatch[2], linkMode),
    lang: getAttribute(htmlAttrs, "lang") ?? getAttribute(htmlAttrs, "xml:lang") ?? "fi",
    title,
  };
}

function renderHtmlDocument(parts: BodyParts, css: string): string {
  const attrs = parts.attrs.trim() ? ` ${parts.attrs.trim()}` : "";
  return `<!doctype html>
<html lang="${escapeAttribute(parts.lang)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(parts.title)}</title>
  <style>
${indent(css.trim(), 4)}
  </style>
</head>
<body${attrs}>
${parts.html.trim()}
</body>
</html>
`;
}

function transformBodyAttributes(attrs: string): string {
  return attrs
    .replace(/\s+xmlns(?::[\w-]+)?=(["']).*?\1/g, "")
    .replace(/\s+xml:lang=(["']).*?\1/g, "")
    .replace(/\bepub:type=/g, "data-epub-type=")
    .replace(/\s+/g, " ")
    .trim();
}

function transformBodyHtml(html: string, linkMode: "multi" | "single"): string {
  let output = html
    .replace(/<p\b(?=[^>]*\bclass="[^"]*\bsource-note\b)[^>]*>[\s\S]*?<\/p>\s*/g, "")
    .replace(/\bepub:type=/g, "data-epub-type=")
    .replace(/\bxlink:href=/g, "href=")
    .replace(/<span\b([^>]*)\/>/g, "<span$1></span>")
    .replace(/<br\s*\/>/g, "<br>")
    .replace(/<hr\s*\/>/g, "<hr>")
    .replace(/<img\b([^>]*)\/>/g, "<img$1>");

  if (linkMode === "single") {
    output = output
      .replace(/\shref="[^"#]+\.xhtml#([^"]+)"/g, ' href="#$1"')
      .replace(/\shref="[^"]+\.xhtml"/g, ' href="#"');
  } else {
    output = output.replace(/\shref="([^"#]+)\.xhtml([^"]*)"/g, ' href="$1.html$2"');
  }

  return output;
}

function htmlToText(html: string): string {
  const tokens = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .match(/<[^>]+>|[^<]+/g) ?? [];

  const paragraphs: string[] = [];
  const stack: Array<{ tag: string; indented: boolean }> = [];
  let current = "";
  let indentDepth = 0;

  const flush = () => {
    const normalized = current.replace(/[ \t\n]+/g, " ").trim();
    if (normalized) {
      paragraphs.push(wrapParagraph(normalized, indentDepth > 0 ? "    " : ""));
    }
    current = "";
  };

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      const text = decodeEntities(token);
      current += `${current && !/\s$/.test(current) ? " " : ""}${text}`;
      continue;
    }

    if (/^<!--/.test(token) || /^<!/.test(token)) {
      continue;
    }

    const endTag = token.match(/^<\/\s*([a-z0-9:-]+)/i);
    if (endTag) {
      const tag = endTag[1].toLowerCase();
      if (isBlockTag(tag)) {
        flush();
      }
      const popped = stack.pop();
      if (popped?.indented) {
        indentDepth--;
      }
      continue;
    }

    const startTag = token.match(/^<\s*([a-z0-9:-]+)([^>]*)>/i);
    if (!startTag) {
      continue;
    }

    const tag = startTag[1].toLowerCase();
    const attrs = startTag[2] ?? "";

    if (tag === "br") {
      current += "\n";
      continue;
    }
    if (tag === "hr") {
      flush();
      paragraphs.push("* * *");
      continue;
    }
    if (tag === "img") {
      const alt = getAttribute(attrs, "alt");
      if (alt) {
        current += `[Illustration: ${decodeEntities(alt)}]`;
      }
      continue;
    }

    if (isBlockTag(tag)) {
      flush();
    }

    const indented = hasIndentingClass(attrs);
    if (indented) {
      indentDepth++;
    }

    if (!isVoidTag(tag) && !token.endsWith("/>")) {
      stack.push({ tag, indented });
    } else if (indented) {
      indentDepth--;
    }
  }

  flush();
  return paragraphs.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hasIndentingClass(attrs: string): boolean {
  const className = getAttribute(attrs, "class") ?? "";
  return /\b(letter|mx-4pct|mx-5pct)\b/.test(className);
}

function isBlockTag(tag: string): boolean {
  return new Set([
    "address",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "ol",
    "p",
    "pre",
    "section",
    "ul",
  ]).has(tag);
}

function isVoidTag(tag: string): boolean {
  return new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
  ]).has(tag);
}

function wrapParagraph(text: string, indent = "", width = 72): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = indent;
  const maxWidth = Math.max(width, indent.length + 20);

  for (const word of words) {
    if (line.trim() === "") {
      line = indent + word;
    } else if (`${line} ${word}`.length > maxWidth) {
      lines.push(line.trimEnd());
      line = indent + word;
    } else {
      line += ` ${word}`;
    }
  }

  if (line.trim()) {
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function getAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}=(["'])(.*?)\\1`);
  return attrs.match(pattern)?.[2];
}

function compareContentNames(a: string, b: string): number {
  return sortKey(a).localeCompare(sortKey(b), "en", { numeric: true });
}

function sortKey(name: string): string {
  if (name === "wrap0000.xhtml") {
    return "0000-cover";
  }
  if (name === "frontmatter.xhtml") {
    return "0001-frontmatter";
  }
  if (name.startsWith("chapter-")) {
    return `0100-${name}`;
  }
  if (name === "notes.xhtml") {
    return "0900-notes";
  }
  if (name === "toc.xhtml") {
    return "0999-toc";
  }
  return `1000-${name}`;
}

function replaceExtension(file: string, extension: string): string {
  return file.replace(/\.[^.]+$/, extension);
}

function indent(text: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return text.split("\n").map((line) => `${padding}${line}`).join("\n");
}

function decodeEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }
    return namedEntities[code.toLowerCase()] ?? entity;
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayPath(url: URL): string {
  return url.href.startsWith(rootDir.href) ? url.href.slice(rootDir.href.length) : url.pathname;
}
