import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { EditorSelection, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { MarkdownView } from "obsidian";
import LiveVariables from "../main";
import {
	isKnownVariable,
	liveVariableRegex,
	resolveLiveVariableValue,
	resolveLiveVariablesInText,
} from "./live-variable-shared";

// Dispatched to force a decoration rebuild when a referenced variable changes
// in another note (which does not itself produce a doc change in this editor).
const refreshLiveVariablesEffect = StateEffect.define<void>();

/** Forces every open markdown editor to recompute its live-variable widgets. */
export const refreshAllLiveVariables = (plugin: LiveVariables) => {
	plugin.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({ effects: refreshLiveVariablesEffect.of() });
		}
	});
};

class LiveVariableWidget extends WidgetType {
	constructor(
		private readonly value: string,
		private readonly highlight: boolean,
		private readonly source: string
	) {
		super();
	}

	eq(other: LiveVariableWidget): boolean {
		return (
			other.value === this.value &&
			other.highlight === this.highlight &&
			other.source === this.source
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.ownerDocument.createElement("span");
		if (this.highlight) {
			span.className = "lv-live-text";
		}
		span.textContent = this.value;
		// A single click selects the whole {{variable}} source so it can be
		// retyped/replaced immediately. We drive the selection ourselves
		// (rather than letting the caret land somewhere inside the widget) so
		// editing never depends on a precise click position.
		span.addEventListener("mousedown", (event) => {
			event.preventDefault();
			const pos = view.posAtDOM(span);
			view.dispatch({
				selection: EditorSelection.range(
					pos,
					pos + this.source.length
				),
			});
			view.focus();
		});
		return span;
	}

	ignoreEvent(): boolean {
		// We handle clicks ourselves (see toDOM), so keep CodeMirror from also
		// moving the caret in response to the same event.
		return true;
	}
}

/**
 * Builds the decorations that replace {{NAME}} tokens with their computed value,
 * except when the selection overlaps a token (so it stays editable as source).
 */
const buildDecorations = (
	view: EditorView,
	plugin: LiveVariables
): DecorationSet => {
	const builder = new RangeSetBuilder<Decoration>();
	const selectionRanges = view.state.selection.ranges;

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		liveVariableRegex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = liveVariableRegex.exec(text)) !== null) {
			const content = match[1];
			if (!isKnownVariable(content, plugin.vaultProperties)) {
				continue;
			}
			const start = from + match.index;
			const end = start + match[0].length;

			// Reveal the raw source for editing in two cases: a collapsed caret
			// sitting on the token, or a selection whose bounds exactly match
			// the token (what a click on the widget produces). A broader
			// multi-character selection keeps the rendered preview so it can be
			// selected and copied as the value.
			const revealSource = selectionRanges.some(
				(range) =>
					(range.empty &&
						range.from <= end &&
						range.to >= start) ||
					(range.from === start && range.to === end)
			);
			if (revealSource) {
				continue;
			}

			const value = resolveLiveVariableValue(
				content,
				plugin.vaultProperties
			);
			if (value === undefined) {
				continue;
			}

			builder.add(
				start,
				end,
				Decoration.replace({
					widget: new LiveVariableWidget(
						value,
						plugin.settings.highlightText,
						match[0]
					),
				})
			);
		}
	}

	return builder.finish();
};

const liveVariableViewPlugin = (plugin: LiveVariables) =>
	ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
			}

			update(update: ViewUpdate) {
				const forced = update.transactions.some((tr) =>
					tr.effects.some((e) => e.is(refreshLiveVariablesEffect))
				);
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.selectionSet ||
					forced
				) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}
		},
		{
			decorations: (instance) => instance.decorations,
		}
	);

// Puts the rendered "preview" text on the clipboard when copying/cutting from
// the editor, so {{NAME}} comes out as its value (honors the opt-out setting).
const liveVariableClipboardFilter = (plugin: LiveVariables) =>
	EditorView.clipboardOutputFilter.of((text) => {
		if (!plugin.settings.copyResolvedValues) {
			return text;
		}
		return resolveLiveVariablesInText(text, plugin.vaultProperties);
	});

export const liveVariableExtension = (plugin: LiveVariables) => [
	liveVariableViewPlugin(plugin),
	liveVariableClipboardFilter(plugin),
];
