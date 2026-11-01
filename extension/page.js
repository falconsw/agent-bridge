// Page-side library, injected (idempotently) in front of every page script as window.__ab.
// Written as a real function so it is syntax-checked; background.js ships its source text.
// Snapshot lines are compact on purpose (token budget): `role "label" rN [state]`.
// Refs live in the page and stay stable for an element until the document changes.
export function installAgentLib() {
  const VERSION = 7;
  if (window.__ab && window.__ab.v === VERSION) return;

  const refs = { map: new Map(), rev: new WeakMap(), n: 0 };
  const refFor = (el) => {
    let r = refs.rev.get(el);
    if (r === undefined) {
      r = ++refs.n;
      refs.rev.set(el, r);
      refs.map.set(r, el);
    }
    return r;
  };

  const SKIP = new Set(["script", "style", "noscript", "svg", "head", "template", "link", "meta"]);
  const INTERACTIVE = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "listbox", "treeitem", "file", "clickable",
  ]);
  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button",
    range: "slider", number: "spinbutton", search: "searchbox", file: "file", color: "button",
  };
  // Icon fonts (Material Symbols etc.) render ligature words like "arrow_upward" as text: drop them.
  let iconWords = null;
  const ICON_SELECTOR = '[class*="material-icons"],[class*="material-symbols"],[class*="google-symbols"],[class*="icon-font"]';
  const loadIcons = () => {
    iconWords = new Set();
    for (const el of document.querySelectorAll(ICON_SELECTOR)) {
      const word = (el.textContent || "").trim();
      if (word && word.length < 40 && !/\s/.test(word)) iconWords.add(word);
    }
  };
  const clean = (s) => {
    let text = (s || "").replace(/\s+/g, " ").trim();
    if (iconWords && iconWords.size && text) text = text.split(" ").filter((w) => !iconWords.has(w)).join(" ");
    return text;
  };
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  // Passwords, OTP and card fields never appear in snapshots (privacy filter).
  const sensitive = (el) => {
    if (el.localName !== "input") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    return /cc-|csc|one-time-code|current-password|new-password/.test((el.getAttribute("autocomplete") || "").toLowerCase());
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit.split(" ")[0];
    const tag = el.localName;
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
      case "summary":
        return "button";
      case "input": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden") return null;
        return INPUT_ROLES[type] || "textbox";
      }
      case "select":
        return "combobox";
      case "textarea":
        return "textbox";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return "h" + tag[1];
      case "img":
        return el.getAttribute("alt") ? "img" : null;
      case "dialog":
        return el.open ? "dialog" : null;
    }
    const editable = el.getAttribute("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only") return "textbox";
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && !el.children.length)) return "clickable";
    return null;
  };

  const labelOf = (el, role) => {
    let s = el.getAttribute("aria-label");
    if (!s) {
      const ids = el.getAttribute("aria-labelledby");
      if (ids) s = ids.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.innerText || "").join(" ");
    }
    if (!s && el.labels && el.labels.length) s = el.labels[0].innerText;
    if (!s && role !== "textbox" && role !== "searchbox" && role !== "combobox") s = el.innerText;
    if (!s) s = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.querySelector?.("img[alt]")?.alt || "";
    return cut(clean(s), 80);
  };

  const stateOf = (el, role, label = "") => {
    const bits = [];
    // Tooltips often carry the exact value behind a rounded label (e.g. 108k → "107,856").
    const tip = el.getAttribute("title") || [...(el.querySelectorAll?.("[title]") ?? [])].map((x) => x.getAttribute("title")).find((x) => /\d/.test(x));
    if (tip && tip.length <= 40 && !label.includes(tip.trim())) bits.push(`title="${clean(tip)}"`);
    if (role === "textbox" || role === "searchbox" || role === "spinbutton") {
      const v = el.isContentEditable ? el.innerText : el.value;
      if (v) bits.push(`value="${cut(clean(v), 40)}"`);
      if (el.getAttribute("placeholder") && !v) bits.push(`ph="${cut(clean(el.getAttribute("placeholder")), 30)}"`);
    } else if (role === "combobox" && el.localName === "select") {
      bits.push(`value="${cut(clean(el.selectedOptions[0]?.text || ""), 30)}"`);
      const opts = [...el.options].slice(0, 8).map((o) => cut(clean(o.text), 20));
      bits.push(`options=[${opts.join("|")}${el.options.length > 8 ? `|+${el.options.length - 8}` : ""}]`);
    }
    if (el.checked || el.getAttribute("aria-checked") === "true") bits.push("checked");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") bits.push("selected");
    return bits.length ? " " + bits.join(" ") : "";
  };

  const hidden = (el) => {
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) return true;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) {
      return getComputedStyle(el).display !== "contents";
    }
    return false;
  };

  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  /** Walks light DOM, open shadow roots and same-origin iframes in document order. */
  function collect(root, { mode = "interactive", viewport = false, cap = 1500 } = {}) {
    const out = []; // { line, el }
    const started = Date.now();
    loadIcons();
    const visit = (el, depth, withText = mode === "all") => {
      if (out.length >= cap || depth > 60 || Date.now() - started > 1500) return;
      const tag = el.localName;
      if (SKIP.has(tag) || hidden(el) || sensitive(el)) return;
      const role = roleOf(el);
      // Data tables (reports, stats, listings): one compact line per row, in every mode.
      if (tag === "tr" || role === "row") {
        const cells = [...el.children].filter((c) => /^(td|th)$/.test(c.localName) || /cell|header/.test(c.getAttribute("role") || ""));
        const texts = cells.map((c) => cut(clean((c.innerText || "").split("\n").filter((x) => x.trim()).slice(0, 2).join(" ")), 60)).filter(Boolean);
        if (texts.length && (!viewport || inViewport(el))) {
          const head = cells.every((c) => c.localName === "th" || /header/.test(c.getAttribute("role") || ""));
          out.push({ line: `${head ? "cols" : "row"} "${cut(texts.slice(0, 8).join(" | "), 300)}"`, el });
        }
        for (const node of el.children) visit(node, depth + 1, false); // still list the row's controls
        return;
      }
      if (role && (INTERACTIVE.has(role) || role[0] === "h" || role === "img" || role === "dialog")) {
        const isHeading = /^h[1-6]$/.test(role);
        if (!viewport || inViewport(el)) {
          const label = labelOf(el, role);
          if (INTERACTIVE.has(role)) {
            out.push({ line: `${role} "${label}" r${refFor(el)}${stateOf(el, role, label)}`, el });
            return; // an interactive element's children are its label
          }
          if (isHeading && label) {
            // A heading that is one link (article/repo titles) becomes a single actionable line.
            const inner = el.querySelectorAll("a[href],button");
            if (inner.length === 1) {
              out.push({ line: `${role} ${roleOf(inner[0])} "${label}" r${refFor(inner[0])}`, el: inner[0] });
              return;
            }
            out.push({ line: `${role} "${label}"`, el });
            if (!inner.length) return;
          }
          if (role === "img" && mode === "all" && label) out.push({ line: `img "${label}"`, el });
          if (role === "dialog") out.push({ line: `dialog "${label.slice(0, 40)}" r${refFor(el)}`, el });
        }
      }
      if (tag === "iframe") {
        try {
          const body = el.contentDocument?.body;
          if (body) visit(body, depth + 1, withText);
        } catch {}
        return;
      }
      const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
      for (const node of kids) {
        if (node.nodeType === 1) visit(node, depth + 1, withText);
        else if (withText && node.nodeType === 3) {
          const text = clean(node.nodeValue);
          if (text.length > 1 && (!viewport || inViewport(el))) out.push({ line: `"${cut(text, 6000)}"`, el });
        }
      }
    };
    if (root) visit(root, 0);
    return out;
  }

  function render({ ref, selector, mode = "interactive", viewport = false, max = 150 } = {}) {
    // A selector may first match an empty placeholder (e.g. a loading <tbody>): take the first with content.
    const matches = selector ? [...document.querySelectorAll(selector)] : [];
    const root = ref !== undefined ? refs.map.get(ref) : selector ? matches.find((m) => clean(m.innerText)) || matches[0] : document.body;
    if (!root) return `# ${document.title}\n${location.href}\n(scope not found)`;
    let lines = collect(root, { mode, viewport }).map((x) => x.line);
    // Content-only pages (JSON, articles without controls): an empty control list says nothing — show the text.
    if (mode === "interactive" && lines.length < 4) lines = collect(root, { mode: "all", viewport }).map((x) => x.line);
    // Collapse runs of identical lines (e.g. repeated "Reload" links) to save tokens.
    const shown = [];
    for (const line of lines) {
      if (shown.length >= max) break;
      const last = shown[shown.length - 1];
      if (last && last.replace(/ r\d+.*$/, "") === line.replace(/ r\d+.*$/, "") && !line.startsWith('"')) continue;
      shown.push(line);
    }
    const more = lines.length > shown.length ? `\n(+${lines.length - shown.length} more — use find, ref/selector scope, viewport:true or a higher max)` : "";
    const scroll = `scroll ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}`;
    return `# ${document.title}\n${location.href} · ${scroll}\n${shown.join("\n")}${more}`;
  }

  // --- action support: remember the state before an action, report only what changed after ---
  let last = null;
  const mark = () => {
    last = { url: location.href, lines: new Set(collect(document.body).map((x) => x.line)) };
  };
  function changes(max = 40) {
    if (!last) return { newDoc: true };
    const now = collect(document.body).map((x) => x.line);
    const nowSet = new Set(now);
    const added = now.filter((l) => !last.lines.has(l));
    let removed = 0;
    for (const l of last.lines) if (!nowSet.has(l)) removed++;
    return { url: location.href, title: document.title, added: added.slice(0, max), addedTotal: added.length, removed, urlChanged: last.url !== location.href };
  }

  /** Resolves when the DOM has been quiet for `idle` ms (or after `cap` ms). */
  const quiet = (idle = 300, cap = 2500) =>
    new Promise((done) => {
      const started = Date.now();
      let timer;
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(hard);
        done(Date.now() - started);
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, idle);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(finish, idle);
      const hard = setTimeout(finish, cap);
    });

  /** Finds the target element: ref (from a snapshot), CSS selector, or visible label text. */
  function resolve({ ref, selector, text } = {}) {
    let el = null;
    if (ref !== undefined) {
      el = refs.map.get(ref);
      if (!el) throw new Error(`r${ref} unknown on this page (page changed?) — run read or find again`);
      if (!el.isConnected) throw new Error(`r${ref} is gone from the page — run read or find again`);
    } else if (selector) {
      el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches ${selector}`);
    } else if (text) {
      const needle = text.toLocaleLowerCase();
      const items = collect(document.body).filter((x) => / r\d+/.test(x.line));
      const label = (x) => (x.line.match(/"(.*)" r\d+/)?.[1] || "").toLocaleLowerCase();
      el = (items.find((x) => label(x) === needle) || items.find((x) => label(x).includes(needle)))?.el;
      if (!el) throw new Error(`no visible element labelled "${text}"`);
    }
    return el;
  }

  /** Scrolls the element into view and returns its center in top-level viewport coordinates. */
  function point(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const f = win.frameElement.getBoundingClientRect();
      x += f.left + win.frameElement.clientLeft;
      y += f.top + win.frameElement.clientTop;
      win = win.parent;
    }
    let warn = "";
    if (el.ownerDocument === document) {
      // elementFromPoint is retargeted to shadow hosts, so compare across shadow boundaries.
      const within = (outer, node) => {
        for (let n = node; n; n = n.parentNode || n.host) if (n === outer) return true;
        return false;
      };
      const hit = document.elementFromPoint(x, y);
      if (hit && !within(el, hit) && !within(hit, el)) {
        warn = `covered by <${hit.localName}${hit.id ? "#" + hit.id : ""}> "${cut(clean(hit.innerText), 40)}" (overlay/popup?)`;
      }
    }
    if (r.width === 0 && r.height === 0) warn = "element has no size (hidden?)";
    return { x: Math.round(x), y: Math.round(y), warn, label: cut(labelOf(el, roleOf(el)), 44) };
  }

  /**
   * Visual cursor: CDP mouse events are invisible, so draw where the agent acts.
   * Lives in a closed shadow root so page scripts cannot see or tamper with it.
   */
  function makeCursor() {
    let host = null, root = null, wrap = null, tip = null, idle = null, tipTimer = null;
    const ensure = () => {
      if (host && host.isConnected) return;
      host = document.createElement("div");
      host.id = "__agent-bridge-cursor";
      host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;";
      host.setAttribute("aria-hidden", "true");
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .layer { position: fixed; inset: 0; pointer-events: none; }
          .wrap { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity .2s ease; will-change: transform; }
          .wrap.on { opacity: 1; }
          .wrap.move { transition: transform .14s cubic-bezier(.2,.8,.3,1); }
          .arrow { position: absolute; left: -3px; top: -3px; width: 26px; height: 26px; filter: drop-shadow(0 2px 4px rgb(0 0 0 / .45)); }
          .tip { position: absolute; left: 20px; top: 22px; max-width: 280px; padding: 4px 9px; border-radius: 8px;
                 background: #111318; color: #fff; font: 12px/1.35 system-ui, -apple-system, sans-serif;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .18s;
                 box-shadow: 0 3px 10px rgb(0 0 0 / .35); }
          .tip.on { opacity: 1; }
          .ripple { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
                    border: 2px solid #ffc23a; background: rgb(255 194 58 / .28); animation: ab-ripple .5s ease-out forwards; }
          .ring { position: absolute; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
                  border: 2px solid #ffc23a; animation: ab-ring .45s ease-out forwards; }
          @keyframes ab-ripple { from { transform: scale(.4); opacity: .95; } to { transform: scale(3.6); opacity: 0; } }
          @keyframes ab-ring { from { transform: scale(.5); opacity: .9; } to { transform: scale(1.7); opacity: 0; } }
        </style>
        <div class="layer">
          <div class="wrap">
            <svg class="arrow" viewBox="0 0 24 24" width="26" height="26">
              <path d="M5 2 L5 19.5 L9.6 15.1 L12.4 20.8 L15.3 19.4 L12.5 13.8 L18.9 13.5 Z"
                    fill="#fff" stroke="#111318" stroke-width="1.1" stroke-linejoin="round"/>
            </svg>
            <div class="tip"></div>
          </div>
        </div>`;
      (document.body || document.documentElement).appendChild(host);
      wrap = root.querySelector(".wrap");
      tip = root.querySelector(".tip");
    };
    const place = (x, y) => {
      ensure();
      wrap.classList.remove("move");
      void wrap.offsetWidth; // restart the transition so the arrow glides to the new spot
      wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      wrap.classList.add("move", "on");
      clearTimeout(idle);
      idle = setTimeout(() => wrap.classList.remove("on"), 2600);
    };
    const say = (text, ms = 1400) => {
      clearTimeout(tipTimer);
      tip.textContent = text;
      tip.classList.add("on");
      tipTimer = setTimeout(() => tip.classList.remove("on"), ms);
    };
    const pulse = (x, y, cls) => {
      const dot = document.createElement("div");
      dot.className = cls;
      dot.style.left = Math.round(x) + "px";
      dot.style.top = Math.round(y) + "px";
      root.querySelector(".layer").appendChild(dot);
      setTimeout(() => dot.remove(), 620);
    };
    return {
      move: (x, y) => place(x, y),
      click: (x, y, label) => {
        place(x, y);
        pulse(x, y, "ring");
        pulse(x, y, "ripple");
        if (label) say(label);
      },
      typed: (text, x, y) => {
        if (x != null && y != null) place(x, y);
        say(`⌨ ${String(text).slice(0, 60)}`, 1600);
      },
      hide: () => {
        clearTimeout(idle);
        if (wrap) wrap.classList.remove("on");
      },
    };
  }

  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    while (a && a.localName === "iframe") {
      try {
        a = a.contentDocument.activeElement;
      } catch {
        break;
      }
    }
    return a;
  };

  /** Focuses a field and selects its content (so typed text replaces it). */
  function prepareType(target, clear) {
    const el = target ? resolve(target) : deepActive();
    if (!el || el === document.body) throw new Error("no field to type into — pass ref/selector");
    if (sensitive(el)) throw new Error("refusing to type into a password/OTP/card field");
    const p = point(el);
    el.focus();
    const focused = deepActive() === el || el.contains(deepActive());
    if (clear) {
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (typeof el.select === "function") el.select();
    }
    return { ...p, focused };
  }

  /** What fill should do with a field: toggle (checkbox/radio), choose (select) or type. */
  function fieldInfo(target) {
    const el = resolve(target);
    const role = roleOf(el);
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const checked = el.checked ?? el.getAttribute("aria-checked") === "true";
      return { kind: "toggle", checked: !!checked, ...point(el) };
    }
    if (el.localName === "select") return { kind: "select" };
    return { kind: "text" };
  }

  function selectOption(target, value) {
    const el = resolve(target);
    if (el.localName !== "select") throw new Error("not a native <select>; open it with click and click the option instead");
    const needle = String(value).toLocaleLowerCase();
    const opt = [...el.options].find((o) => o.value === value || o.text.trim().toLocaleLowerCase() === needle) ||
      [...el.options].find((o) => o.text.toLocaleLowerCase().includes(needle));
    if (!opt) throw new Error(`no option "${value}"; options: ${[...el.options].map((o) => o.text.trim()).slice(0, 20).join(" | ")}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, opt.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text.trim();
  }

  /** Text search: matching interactive elements and text snippets, each with a ref to act on. */
  function find(query, max = 20) {
    const needle = query.toLocaleLowerCase();
    const word = new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u");
    const exact = [];
    const partial = [];
    for (const { line, el } of collect(document.body, { mode: "all", cap: 4000 })) {
      const lower = line.toLocaleLowerCase();
      if (!lower.includes(needle)) continue;
      (word.test(lower) ? exact : partial).push({ line, el });
      if (exact.length >= max) break;
    }
    const hits = [...exact, ...partial].slice(0, max).map(({ line, el }) => {
      line = String(line);
      if (/ r\d+/.test(line)) {
        const href = el.localName === "a" && el.href && !el.href.startsWith("javascript:") ? ` → ${cut(el.href, 100)}` : "";
        return line + href;
      }
      // Text: show the surrounding block (e.g. "107.9k stars", not just "stars") and give it a ref.
      let block = el;
      while (block.parentElement && block !== document.body && clean(block.innerText).length < 25) block = block.parentElement;
      const context = clean(block.innerText);
      if (context.length > line.length - 2 && context.length <= 240) line = `"${context}"`;
      let host = el;
      while (host && host !== document.body && !INTERACTIVE.has(roleOf(host) || "")) host = host.parentElement;
      return `${line} r${refFor(host && host !== document.body ? host : el)}`;
    });
    const unique = [...new Set(hits.map((h) => h.replace(/ r\d+$/, "")))].map((h) => hits.find((x) => x.startsWith(h)));
    return unique.length ? unique.join("\n") : `no match for "${query}" on ${location.href}`;
  }

  window.__ab = { v: VERSION, render, mark, changes, quiet, resolve, point, prepareType, selectOption, fieldInfo, find, refFor, cursor: makeCursor() };
}
