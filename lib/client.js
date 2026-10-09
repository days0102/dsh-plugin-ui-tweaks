window.__ModuleLoader__.load({
	id: "dsh-plugin-ui-tweaks",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * No required client service: every feature below is a DOM/CSS side effect, so the
		 * plugin never waits for another plugin's registration ledger.
		 */
		const inject = [];

		//#region settings
		/**
		 * Feature settings.
		 *
		 * Constants for now. When this package grows a settings page, these become the
		 * defaults that an injected/ctx-backed config layer overrides — the feature code
		 * reads SETTINGS and never hardcodes a value, so adding a UI means changing only
		 * how SETTINGS is produced (plus a styles rebuild for the CSS-derived parts).
		 */
		const SETTINGS = {
			/**
			 * Terminal command banner resting state.
			 *   true  — start wrapped, so a long command is fully visible; a click collapses it.
			 *   false — start truncated with an ellipsis; a click expands it.
			 * One click always toggles away from whatever this is set to.
			 */
			commandExpandedByDefault: false,
			/**
			 * Label swapped in on the prompt label after the command is copied.
			 *
			 * Hardcoded Chinese for now — this package has no locale seat yet. `ctx.locale`
			 * exists on the client root, so the settings-page work should move this (and every
			 * other user-facing string) behind it.
			 */
			copiedFeedback: "已复制",
			/**
			 * Sent-prompt bubble: how many lines stay visible while collapsed. The cap is
			 * applied in CSS; whether it *bites* is measured in JS (see
			 * {@link installPromptCollapse}), so short prompts render untouched.
			 */
			promptClampLines: 12,
			/**
			 * Affordances on a clamped prompt: without them a collapsed prompt just stops
			 * mid-sentence and nothing says it can be opened. Both are generated content, so
			 * `user-select: none` keeps them out of a copied prompt.
			 */
			promptExpandHint: "点击展开",
			promptCollapseHint: "点击收起"
		};
		//#endregion

		//#region shared: genuine-click gestures
		/** Hooks that never belong to a click target: real controls keep their own behaviour. */
		const INTERACTIVE = "button, a, input, textarea, select, summary, [contenteditable]";
		/**
		 * Pointer travel (px) between press and release above which the gesture is a drag —
		 * a text selection, not a click.
		 *
		 * Browsers fire `click` even when the press and release were a selection drag, so
		 * without this every select-to-copy gesture would also activate whatever sits under
		 * it, and the reflow from that activation destroys the very selection being made.
		 * This threshold, the selection check, and the multi-click handling below are what
		 * keep text selection working on every surface this plugin touches.
		 */
		const DRAG_THRESHOLD_PX = 4;

		/** The document's current selection, when the environment exposes one. */
		function currentSelection() {
			return typeof document.getSelection === "function" ? document.getSelection() : null;
		}

		/**
		 * Install a document-level gesture gate shared by every click-driven feature here.
		 *
		 * `onClick` runs only for a real click: primary button, press and release within
		 * {@link DRAG_THRESHOLD_PX}, and no text selected. `onDoubleClick` always runs and
		 * lets a feature undo whatever the first click of a multi-click gesture did, since a
		 * double-click (select word) and triple-click (select line) start as an ordinary click.
		 *
		 * Bound on the document rather than per element, so nodes rendered later need no
		 * wiring and nothing has to watch the tree for interactions.
		 *
		 * @param handlers - the click and double-click callbacks.
		 * @returns the disposer that removes every listener.
		 */
		function installClickGestures({ onClick, onDoubleClick }) {
			/** Press origin of the current primary-button gesture, or null. */
			let press = null;

			const onMouseDown = (event) => {
				/* A non-primary button (right/middle drag-select included) never counts. */
				press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
			};

			const handleClick = (event) => {
				const origin = press;
				press = null;
				if (origin === null) return;
				if (event.detail > 1) return;
				if (Math.abs(event.clientX - origin.x) > DRAG_THRESHOLD_PX) return;
				if (Math.abs(event.clientY - origin.y) > DRAG_THRESHOLD_PX) return;
				const selection = currentSelection();
				if (selection !== null && selection.isCollapsed === false && selection.toString() !== "") return;
				onClick(event);
			};

			const handleDoubleClick = (event) => {
				if (onDoubleClick !== undefined) onDoubleClick(event);
			};

			document.addEventListener("mousedown", onMouseDown, true);
			document.addEventListener("click", handleClick, true);
			document.addEventListener("dblclick", handleDoubleClick, true);
			return () => {
				document.removeEventListener("mousedown", onMouseDown, true);
				document.removeEventListener("click", handleClick, true);
				document.removeEventListener("dblclick", handleDoubleClick, true);
			};
		}
		//#endregion

		//#region feature: terminal command banner
		/**
		 * Why this feature exists
		 * ----------------------
		 * `TerminalBlock` (dsh-client-ui-primitives) renders the command banner as
		 *   .command { white-space: var(--dsl-terminal-command-whitespace, pre);
		 *              overflow: hidden; text-overflow: ellipsis; }
		 * so a command wider than the card is clipped to `…` with no disclosure of its own.
		 * The component documents a host opt-out: rebind the variable to `pre-wrap`. The
		 * background-jobs panel does exactly that (`dsh-client-ui-jobs`), the chat tool card
		 * (`dsh-client-ui-tool` .terminalBody) does not — which is the gap this closes.
		 *
		 * Click-to-toggle is safe here: the tool row's disclosure lives on a SEPARATE
		 * sibling element. `DisclosureRow` renders `[div[data-disclosure-row] (the click
		 * target), children (the card)]`, so a click inside the expanded card never reaches
		 * the row's onToggle and the two never fight.
		 *
		 * Both the resting style and the toggled style are driven by one attribute on the
		 * block root, which is the only node this feature touches; React keeps that node
		 * across re-renders, and React never manages this attribute, so the state survives
		 * output streaming and re-renders (it resets only if the row is unmounted).
		 *
		 * The second gap this closes is copying the command. The `host` / `$` markers are
		 * prompt labels — separate spans, not part of the command — so selecting the command
		 * by hand drags them into the clipboard, and the card's own copy button copies the
		 * OUTPUT (the tool card passes no `copyText`; only the jobs panel does). Clicking a
		 * label copies the raw command instead, reassembled from the command spans.
		 */
		/** Per-card banner state attribute; this feature is its only writer. */
		const COMMAND_STATE = "data-ui-tweaks-command";
		/** Marks the prompt label currently showing the copied feedback, for its green tint. */
		const COPIED = "data-ui-tweaks-copied";
		/** How long the copied feedback stays in place. */
		const COPIED_FEEDBACK_MS = 1200;
		/**
		 * A double-click is the select-word gesture and a triple-click the select-line one;
		 * their first click still looks like a plain click, so a `dblclick` arriving shortly
		 * after one of our toggles undoes that toggle. The gesture ends up selecting text
		 * without changing the banner.
		 */
		const MULTI_CLICK_REVERT_MS = 700;

		/**
		 * Current resting state of one card's banner, resolving the attribute's absence to
		 * the configured default.
		 * @param block - a `[data-terminal]` block root.
		 * @returns whether the banner is currently wrapped (expanded).
		 */
		function commandExpanded(block) {
			const state = block.getAttribute(COMMAND_STATE);
			if (state === "expanded") return true;
			if (state === "collapsed") return false;
			return SETTINGS.commandExpandedByDefault;
		}

		/**
		 * Resolve the terminal block whose command banner owns a pointer event.
		 * @param target - the event target.
		 * @returns the block root, or null when the event is not on a command banner.
		 */
		function bannerBlock(target) {
			if (target === null || typeof target.closest !== "function") return null;
			if (target.closest(INTERACTIVE) !== null) return null;
			const block = target.closest("[data-terminal]");
			if (block === null) return null;
			/* Only the command banner toggles — it is the block's first child. The output
			   region below stays a plain reading surface, so text selection there is
			   untouched. */
			const banner = block.firstElementChild;
			return banner !== null && banner.contains(target) ? block : null;
		}

		/**
		 * Write one card's banner state.
		 * @param block - the block root.
		 * @param state - `"expanded"`, `"collapsed"`, or null to fall back to the default.
		 */
		function setCommandState(block, state) {
			if (state === null) block.removeAttribute(COMMAND_STATE);
			else block.setAttribute(COMMAND_STATE, state);
		}

		/**
		 * The banner's structure, as `TerminalBlock` renders it:
		 *
		 *   div[data-terminal]
		 *   └── div.header                  ← block.firstElementChild
		 *       └── div.prompt              ← header.firstElementChild
		 *           ├── span.runStateLabel  ← visually hidden; not a div, so it never counts
		 *           └── div.promptLine × N
		 *               ├── (span.runState) ← decorative state dot, first line only
		 *               ├── span.cwd        ← prompt label: the cwd's last segment, or "$"
		 *               └── span.command    ← the raw command line, always the last element child
		 *
		 * These helpers and the CSS below are the only places that know this shape. It is the
		 * feature's one fragile dependency — see the README's known limitations.
		 */
		/** The prompt element holding a block's command lines. */
		function promptOf(block) {
			const header = block.firstElementChild;
			return header === null ? null : header.firstElementChild;
		}

		/** A block's command lines, in render order. */
		function linesOf(block) {
			const prompt = promptOf(block);
			if (prompt === null) return [];
			return Array.from(prompt.children).filter((child) => child.tagName === "DIV");
		}

		/** One line's prompt label — the element just before its command span. */
		function cwdOf(line) {
			return line.children.length >= 2 ? line.children[line.children.length - 2] : null;
		}

		/** One line's command span — always its last element child. */
		function commandOf(line) {
			return line.lastElementChild;
		}

		/**
		 * The block's raw command, one line per rendered line.
		 *
		 * Continuation lines stay in the DOM while collapsed (`display:none` does not remove
		 * them), so the copy payload is complete in either state.
		 *
		 * @param block - a `[data-terminal]` block root.
		 * @returns the command text.
		 */
		function commandTextOf(block) {
			return linesOf(block).map((line) => {
				const command = commandOf(line);
				return command === null ? "" : command.textContent ?? "";
			}).join("\n");
		}

		/**
		 * The prompt label a click landed on, when it landed on one.
		 * @param target - the event target.
		 * @param block - the block already resolved by {@link bannerBlock}.
		 * @returns the label element, or null when the click missed every label.
		 */
		function cwdLabelOf(target, block) {
			const prompt = promptOf(block);
			if (prompt === null) return null;
			for (let node = target; node !== null && node !== prompt; node = node.parentElement) {
				if (node.parentElement === prompt) {
					const label = cwdOf(node);
					return label !== null && label.contains(target) ? label : null;
				}
			}
			return null;
		}

		/**
		 * Copy text to the clipboard.
		 *
		 * The async Clipboard API needs a secure context (`http://127.0.0.1` and `localhost`
		 * count) and can still reject; the hidden-textarea path covers everything else.
		 * @param text - the payload.
		 * @returns whether the copy was reported successful.
		 */
		function writeClipboard(text) {
			const clipboard = typeof navigator === "undefined" || navigator === null ? undefined : navigator.clipboard;
			if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
				try {
					return clipboard.writeText(text).then(() => true, () => legacyCopy(text));
				} catch {
					/* fall through to the legacy path */
				}
			}
			return legacyCopy(text);
		}

		/**
		 * Copy through a hidden textarea and `document.execCommand`, for environments without
		 * the async Clipboard API.
		 * @param text - the payload.
		 * @returns whether the copy reported success.
		 */
		function legacyCopy(text) {
			if (typeof document.body !== "object" || document.body === null) return false;
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.top = "-1000px";
			document.body.appendChild(area);
			area.select();
			let ok = false;
			try {
				ok = document.execCommand("copy") === true;
			} catch {
				ok = false;
			}
			area.remove();
			return ok;
		}

		/**
		 * Install the banner gestures. Two gestures share one gate:
		 *
		 *   - click a prompt label (`host` / `$`) → copy the raw command, then show `已复制`
		 *     in that label's place for a moment;
		 *   - click anywhere else on the banner → toggle collapsed / expanded.
		 *
		 * The label is checked first, so copying never toggles and toggling never copies — the
		 * two hit areas stay disjoint even though both live on the banner.
		 *
		 * @returns the disposer that removes every listener and pending feedback.
		 */
		function installCommandBanner() {
			/** The toggle a multi-click gesture may need to undo, or null. */
			let lastToggle = null;
			/** label → { timer, text }: pending feedback, so a second copy can reset it. */
			const copied = new Map();

			/**
			 * Swap a prompt label for the copied acknowledgement, keeping the original text to
			 * put back.
			 * @param label - the prompt label element.
			 */
			function markCopied(label) {
				const pending = copied.get(label);
				if (pending !== undefined) clearTimeout(pending.timer);
				const text = pending === undefined ? label.textContent ?? "" : pending.text;
				label.setAttribute(COPIED, "");
				label.textContent = SETTINGS.copiedFeedback;
				copied.set(label, {
					text,
					timer: setTimeout(() => clearCopied(label), COPIED_FEEDBACK_MS)
				});
			}

			/**
			 * Put a prompt label back the way `TerminalBlock` rendered it.
			 * @param label - the prompt label element.
			 */
			function clearCopied(label) {
				const pending = copied.get(label);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				label.removeAttribute(COPIED);
				label.textContent = pending.text;
				copied.delete(label);
			}

			/**
			 * Copy one card's command and acknowledge it on the label that was clicked. A
			 * rejected write takes the acknowledgement back instead of lying about it.
			 * @param label - the prompt label element.
			 * @param block - the block root.
			 */
			function copyCommand(label, block) {
				markCopied(label);
				Promise.resolve(writeClipboard(commandTextOf(block))).then((ok) => {
					if (ok !== true) clearCopied(label);
				}, () => clearCopied(label));
			}

			const disposeGestures = installClickGestures({
				onClick: (event) => {
					const block = bannerBlock(event.target);
					if (block === null) return;
					const label = cwdLabelOf(event.target, block);
					if (label !== null) {
						copyCommand(label, block);
						return;
					}
					lastToggle = { block, previous: block.getAttribute(COMMAND_STATE), at: Date.now() };
					setCommandState(block, commandExpanded(block) ? "collapsed" : "expanded");
				},
				onDoubleClick: (event) => {
					if (lastToggle === null) return;
					if (Date.now() - lastToggle.at > MULTI_CLICK_REVERT_MS) return;
					if (bannerBlock(event.target) !== lastToggle.block) return;
					setCommandState(lastToggle.block, lastToggle.previous);
					lastToggle = null;
				}
			});

			return () => {
				disposeGestures();
				for (const label of [...copied.keys()]) clearCopied(label);
			};
		}

		/**
		 * Stylesheet text for the banner feature.
		 *
		 * Collapsed shows only the first command line; expanded lays the whole command out
		 * and lifts the banner's own 150px scroll cap, so "expanded" actually means the
		 * command is fully readable instead of re-wrapped inside the same scroll box. Both
		 * rules are generated from {@link SETTINGS.commandExpandedByDefault}, so the default
		 * lives in exactly one place.
		 *
		 * @returns the CSS block.
		 */
		function commandStyles() {
			const explicit = (value) => `[data-terminal][${COMMAND_STATE}="${value}"]`;
			const implicit = (value) => `[data-terminal]:not([${COMMAND_STATE}="${value}"])`;
			const expanded = SETTINGS.commandExpandedByDefault ? implicit("collapsed") : explicit("expanded");
			const collapsed = SETTINGS.commandExpandedByDefault ? explicit("collapsed") : implicit("expanded");
			return [
				`${expanded}{--dsl-terminal-command-whitespace:pre-wrap}`,
				/* 展开 = 让整条命令铺开：解除横幅自身的限高与滚动。 */
				`${expanded} > div:first-child{max-height:none;overflow-y:visible}`,
				/* 收起 = 只留第一行；续行整条不显示，因而也不会再把横幅撑成滚动区。 */
				`${collapsed}{--dsl-terminal-command-whitespace:pre}`,
				`${collapsed} > div:first-child > div:first-child > div:nth-of-type(n+2){display:none}`,
				/* Zero-specificity hint: the banner is the block's click target. */
				`:where([data-terminal]) > div:first-child{cursor:pointer}`,
				/* 提示符标签是另一个点击目标（复制命令）。它是每个命令行的倒数第二个子元素
				   —— 最后一个是命令 span；用 `nth-last-child` 而不是 `nth-child`，第 1 行那个
				   装饰性的状态点在最前面，不影响从后往前数。 */
				`[data-terminal] > div:first-child > div:first-child > div > span:nth-last-child(2){cursor:pointer}`,
				`[data-terminal] > div:first-child > div:first-child > div > span:nth-last-child(2):hover{color:var(--dsw-alias-label-secondary)}`,
				`[data-terminal] [${COPIED}]{color:var(--dsw-alias-state-success-primary)}`
			].join("\n");
		}
		//#endregion

		//#region feature: long sent prompt
		/**
		 * Why this feature exists
		 * ----------------------
		 * The sent-prompt bubble (`dsh-client-ui-chat` UserStyleBubble) has no height policy:
		 *   .bubble { max-width: 100%; white-space: pre-wrap; padding: 10px 16px; }
		 * so a long prompt pushes the whole conversation aside instead of collapsing.
		 *
		 * Picking the bubble out is the hard part — unlike `TerminalBlock`, the chat package
		 * puts no data attribute on it. What IS stable is the flow item that wraps every node:
		 * `[data-chat-flow-kind="user"]` (set by ChatView from the node kind). Inside it the
		 * bubble carries only its CSS-module class, whose generated name always keeps the
		 * source name as a suffix (`Sixlwa_bubble`, or `<hash>_<name>` in other packages), so
		 * `[class*="_bubble"]` finds it across builds. Tooltips also use a `_bubble_*` class,
		 * but they portal to `body` and never appear inside a user flow item.
		 *
		 * CSS cannot measure overflow, and the clamp must not touch short prompts (a fade over
		 * a two-line message would be a lie), so {@link installPromptCollapse} measures each
		 * bubble once and writes the verdict as an attribute the stylesheet keys on. That
		 * attribute also gates the click, so a prompt that fits is not clickable at all.
		 */
		/** The sent-prompt bubble inside a user flow item. */
		const PROMPT_BUBBLE = '[data-chat-flow-kind="user"] [class*="_bubble"]';
		/** Set by measurement: this bubble's content exceeds the collapsed cap. */
		const PROMPT_CLAMPED = "data-ui-tweaks-prompt-clamped";
		/** Set by the user: this bubble is showing in full. */
		const PROMPT_OPEN = "data-ui-tweaks-prompt-open";

		/**
		 * Flag a bubble whose content exceeds the collapsed cap.
		 *
		 * The cap has to be IN EFFECT for the measurement to mean anything: an unclamped
		 * bubble reports `clientHeight === scrollHeight`, so asking first and clamping after
		 * would never flag anything at all. So this applies the flag, measures, and drops the
		 * flag again when the content fits — all inside one task, so nothing paints in
		 * between and a short prompt never flashes a fade.
		 *
		 * An open bubble keeps whatever verdict it already carried: it is the collapsed state
		 * that was measured, and re-measuring while it is laid out in full would always say
		 * "fits". {@link installPromptCollapse} re-measures it when it closes.
		 *
		 * @param bubble - the bubble element.
		 */
		function refreshPromptClamp(bubble) {
			if (bubble.hasAttribute(PROMPT_OPEN)) return;
			bubble.setAttribute(PROMPT_CLAMPED, "");
			if (bubble.scrollHeight > bubble.clientHeight + 1) return;
			bubble.removeAttribute(PROMPT_CLAMPED);
		}

		/**
		 * Install the sent-prompt collapse: measure every bubble, keep measuring new ones, and
		 * let a click on a clamped bubble open or close it.
		 * @returns the disposer that stops observing and clears open bubbles.
		 */
		function installPromptCollapse() {
			const refreshAll = () => {
				for (const bubble of document.querySelectorAll(PROMPT_BUBBLE)) refreshPromptClamp(bubble);
			};
			/**
			 * Measure a subtree that just entered the document.
			 * @param node - one added node.
			 */
			const sweep = (node) => {
				if (node === null || node.nodeType !== 1) return;
				if (typeof node.matches === "function" && node.matches(PROMPT_BUBBLE)) refreshPromptClamp(node);
				if (typeof node.querySelectorAll !== "function") return;
				for (const bubble of node.querySelectorAll(PROMPT_BUBBLE)) refreshPromptClamp(bubble);
			};

			/* History may already contain prompts; new ones arrive through the observer. A
			   mutation whose added nodes hold no bubble costs one `matches` call each, and only
			   a found bubble triggers a layout read. */
			refreshAll();
			let observer = null;
			if (typeof MutationObserver === "function") {
				observer = new MutationObserver((records) => {
					for (const record of records) for (const node of record.addedNodes) sweep(node);
				});
				observer.observe(document.body, { childList: true, subtree: true });
			}
			/* A resize changes how much fits, so every closed bubble is re-measured. */
			const onResize = () => refreshAll();
			if (typeof window.addEventListener === "function") window.addEventListener("resize", onResize);

			const disposeGestures = installClickGestures({
				onClick: (event) => {
					if (event.target.closest(INTERACTIVE) !== null) return;
					const bubble = event.target.closest(PROMPT_BUBBLE);
					if (bubble === null || !bubble.hasAttribute(PROMPT_CLAMPED)) return;
					if (bubble.hasAttribute(PROMPT_OPEN)) {
						bubble.removeAttribute(PROMPT_OPEN);
						refreshPromptClamp(bubble);
						return;
					}
					bubble.setAttribute(PROMPT_OPEN, "");
				}
			});

			return () => {
				disposeGestures();
				if (observer !== null) observer.disconnect();
				if (typeof window.removeEventListener === "function") window.removeEventListener("resize", onResize);
				for (const bubble of document.querySelectorAll(`[${PROMPT_OPEN}]`)) bubble.removeAttribute(PROMPT_OPEN);
			};
		}

		/**
		 * Stylesheet text for the sent-prompt collapse.
		 *
		 * The cap mirrors the bubble's own geometry: `line-height: calc(22px + delta)` per line
		 * plus its `10px 16px` padding, so the clamped box always ends on a whole line.
		 *
		 * The fade is an overlay pseudo-element, not a `mask-image`: a mask would fade the
		 * hint along with the text, and the hint is the whole point. `background: inherit`
		 * gives the overlay (and the hint chip) the bubble's own fill without this plugin
		 * having to know the bubble colour. `::after` paints above `::before`, so the hint
		 * stays legible over the fade.
		 *
		 * @returns the CSS block.
		 */
		function promptStyles() {
			const lineHeight = "calc(22px + var(--dsh-content-font-delta, 0px))";
			const cap = `calc(${lineHeight} * ${SETTINGS.promptClampLines} + 20px)`;
			const bubble = `[data-chat-flow-kind="user"] [class*="_bubble"]`;
			const closed = `${bubble}[${PROMPT_CLAMPED}]:not([${PROMPT_OPEN}])`;
			const open = `${bubble}[${PROMPT_CLAMPED}][${PROMPT_OPEN}]`;
			const hint = "font-size:11px;line-height:16px;user-select:none;-webkit-user-select:none";
			return [
				`${closed}{position:relative;max-height:${cap};overflow:hidden;cursor:pointer}`,
				/* 覆盖式渐隐：跟随气泡底色，从透明过渡到不透明，压住被截断的那一行。 */
				`${closed}::before{content:"";position:absolute;left:0;right:0;bottom:0;height:34px;background:inherit;` +
					`-webkit-mask-image:linear-gradient(to bottom, transparent, #000);mask-image:linear-gradient(to bottom, transparent, #000)}`,
				/* 提示做成胶囊：不透明底色保证压在渐隐文字上仍然可读，细边让它看起来可点。 */
				`${closed}::after{content:${JSON.stringify(SETTINGS.promptExpandHint)};position:absolute;left:50%;bottom:2px;` +
					`transform:translateX(-50%);padding:0 8px;border-radius:999px;background:inherit;` +
					`border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);${hint}}`,
				/* 展开态：末尾给一个收起提示，否则用户不知道还能点回去。 */
				`${open}{position:relative;cursor:pointer}`,
				`${open}::after{content:${JSON.stringify(SETTINGS.promptCollapseHint)};display:block;margin-top:6px;` +
					`color:var(--dsw-alias-label-tertiary);${hint}}`
			].join("\n");
		}
		//#endregion

		//#region feature: region font sizes (planned)
		/**
		 * Not implemented yet. When the settings page lands, add the rules here and append
		 * `fontStyles()` to {@link STYLES} — no other wiring is needed.
		 *
		 * The variables worth rebinding per region (all read by shipped stylesheets):
		 *   :root                                  --dsh-content-font-size-secondary / --dsh-content-font-delta
		 *   [data-terminal]                        --dsl-terminal-font, --dsl-terminal-line-height
		 *   .md-code-block                        --dsl-code-block-content-font
		 *   [data-read] / [data-diff] / [data-search]  the matching per-card font variables
		 * `dsh-client-ui-theme` already owns the global `fontSize` setting (currently 15 in
		 * this profile's patch); per-region overrides belong on top of that, not instead.
		 */
		//#endregion

		//#region assembly
		/** Every feature's stylesheet text, injected as one `<style>`. */
		const STYLES = [commandStyles(), promptStyles()].join("\n");
		/** Every feature's behaviour installer, run for this plugin's lifetime. */
		const BEHAVIOURS = [
			{ id: "terminal-command-banner", install: installCommandBanner },
			{ id: "sent-prompt-collapse", install: installPromptCollapse }
		];

		/**
		 * Apply every feature.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-ui-tweaks");
				style.textContent = STYLES;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-plugin-ui-tweaks: feature styles");
			for (const behaviour of BEHAVIOURS) ctx.effect(behaviour.install, `dsh-plugin-ui-tweaks: ${behaviour.id}`);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
