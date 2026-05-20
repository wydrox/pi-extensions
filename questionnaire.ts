/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 * Multi-select questions: checkbox-style selection with a Done action
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & {
	isOther?: boolean;
	isDone?: boolean;
	isCustomSelection?: boolean;
	sourceIndex?: number;
};

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiSelect: boolean;
}

interface SelectedAnswerItem {
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	wasMultiSelect?: boolean;
	values?: string[];
	labels?: string[];
	indices?: number[];
	selections?: SelectedAnswerItem[];
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options before answering (default: false)" }),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function selectionKey(value: string, wasCustom: boolean): string {
	return `${wasCustom ? "custom" : "option"}\u0000${value}`;
}

function formatSelection(selection: SelectedAnswerItem): string {
	if (selection.wasCustom) {
		return `(wrote) ${selection.label}`;
	}
	return selection.index ? `${selection.index}. ${selection.label}` : selection.label;
}

function formatAnswer(answer: Answer): string {
	if (answer.wasMultiSelect) {
		return (answer.selections || []).map(formatSelection).join(", ") || answer.label;
	}
	if (answer.wasCustom) {
		return `(wrote) ${answer.label}`;
	}
	return answer.index ? `${answer.index}. ${answer.label}` : answer.label;
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Supports single-select and per-question multiSelect questions. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams as any,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { questions: Array<Question & { allowOther?: boolean }> };
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
				multiSelect: q.multiSelect === true,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();
				const multiDrafts = new Map<string, SelectedAnswerItem[]>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function getMultiDraft(questionId: string): SelectedAnswerItem[] {
					let draft = multiDrafts.get(questionId);
					if (!draft) {
						draft = [];
						multiDrafts.set(questionId, draft);
					}
					return draft;
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = q.options.map((opt, i) => ({ ...opt, sourceIndex: i + 1 }));
					if (q.multiSelect) {
						for (const selection of getMultiDraft(q.id).filter((item) => item.wasCustom)) {
							opts.push({
								value: selection.value,
								label: selection.label,
								isCustomSelection: true,
							});
						}
					}
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					if (q.multiSelect) {
						const selectedCount = getMultiDraft(q.id).length;
						opts.push({
							value: "__done__",
							label: "Done",
							description: selectedCount > 0 ? `${selectedCount} selected` : "Select at least one option first",
							isDone: true,
						});
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				function saveMultiAnswer(questionId: string) {
					const selections = getMultiDraft(questionId);
					if (selections.length === 0) {
						answers.delete(questionId);
						return;
					}
					const values = selections.map((selection) => selection.value);
					const labels = selections.map((selection) => selection.label);
					const indices = selections
						.map((selection) => selection.index)
						.filter((index): index is number => index !== undefined);
					answers.set(questionId, {
						id: questionId,
						value: values.join(", "),
						label: labels.join(", "),
						wasCustom: selections.some((selection) => selection.wasCustom),
						wasMultiSelect: true,
						values,
						labels,
						indices,
						selections: selections.map((selection) => ({ ...selection })),
					});
				}

				function isMultiOptionSelected(q: Question, opt: RenderOption): boolean {
					if (!q.multiSelect || opt.isOther || opt.isDone) return false;
					return getMultiDraft(q.id).some(
						(selection) =>
							selectionKey(selection.value, selection.wasCustom) ===
							selectionKey(opt.value, opt.isCustomSelection === true),
					);
				}

				function toggleMultiOption(q: Question, opt: RenderOption) {
					const draft = getMultiDraft(q.id);
					const wasCustom = opt.isCustomSelection === true;
					const key = selectionKey(opt.value, wasCustom);
					const existingIndex = draft.findIndex(
						(selection) => selectionKey(selection.value, selection.wasCustom) === key,
					);
					if (existingIndex >= 0) {
						draft.splice(existingIndex, 1);
					} else {
						draft.push({
							value: opt.value,
							label: opt.label,
							wasCustom,
							index: wasCustom ? undefined : opt.sourceIndex,
						});
					}
					saveMultiAnswer(q.id);
					refresh();
				}

				function addCustomMultiSelection(q: Question, value: string) {
					const draft = getMultiDraft(q.id);
					const key = selectionKey(value, true);
					if (!draft.some((selection) => selectionKey(selection.value, selection.wasCustom) === key)) {
						draft.push({ value, label: value, wasCustom: true });
					}
					saveMultiAnswer(q.id);
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					const q = questions.find((question) => question.id === inputQuestionId);
					if (q?.multiSelect) {
						addCustomMultiSelection(q, trimmed);
						const customCount = getMultiDraft(q.id).filter((item) => item.wasCustom).length;
						optionIndex = Math.min(q.options.length + customCount, currentOptions().length - 1);
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						refresh();
						return;
					}
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if ((matchesKey(data, Key.enter) || data === " ") && q) {
						const opt = opts[optionIndex];
						if (!opt) return;

						if (q.multiSelect) {
							if (opt.isOther) {
								inputMode = true;
								inputQuestionId = q.id;
								editor.setText("");
								refresh();
								return;
							}
							if (opt.isDone) {
								if (answers.has(q.id)) {
									advanceAfterAnswer();
								} else {
									refresh();
								}
								return;
							}
							toggleMultiOption(q, opt);
							return;
						}

						if (!matchesKey(data, Key.enter)) return;
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();

					// Helper to add truncated line
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const isDone = opt.isDone === true;
							const isMultiSelect = q?.multiSelect === true;
							const doneReady = !isDone || (q ? answers.has(q.id) : false);
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected
								? doneReady
									? "accent"
									: "warning"
								: isDone
									? doneReady
										? "success"
										: "dim"
									: "text";
							let optionLabel = `${i + 1}. ${opt.label}`;

							if (isMultiSelect && !isOther && !isDone && q) {
								const checked = isMultiOptionSelected(q, opt) ? "[x]" : "[ ]";
								const customSuffix = opt.isCustomSelection ? " (custom)" : "";
								optionLabel = `${i + 1}. ${checked} ${opt.label}${customSuffix}`;
							} else if (isDone) {
								optionLabel = `✓ ${opt.label}`;
							} else if (isOther && inputMode) {
								optionLabel = `${i + 1}. ${opt.label} ✎`;
							}

							add(prefix + theme.fg(color, optionLabel));
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}
					}

					// Content
					if (inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", formatAnswer(answer))}`);
							}
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							add(theme.fg("warning", ` Unanswered: ${missing}`));
						}
					} else if (q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = q?.multiSelect
							? isMulti
								? " Tab/←→ navigate • ↑↓ move • Space/Enter toggle • Done to continue • Esc cancel"
								: " ↑↓ move • Space/Enter toggle • Done to submit • Esc cancel"
							: isMulti
								? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
								: " ↑↓ navigate • Enter select • Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasMultiSelect) {
					return `${qLabel}: user selected: ${formatAnswer(a)}`;
				}
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${formatAnswer(a)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
