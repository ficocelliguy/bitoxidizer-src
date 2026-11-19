import * as monaco from "monaco-editor";
import { loadThemes, makeTheme } from "./ui/themes";
import { Settings } from "../Settings/Settings";
import { NetscriptExtra } from "../NetscriptFunctions/Extra";
import * as enums from "../Enums";
import { ns } from "../NetscriptFunctions";
import { isLegacyScript, type ScriptFilePath } from "../Paths/ScriptFilePath";
import { exceptionAlert } from "../utils/helpers/exceptionAlert";
import { GetServer } from "../Server/AllServers";
import {
  getRustCompletions,
  getRustDefinition,
  getRustHover,
  getRustReferences,
  getRustRename,
  getRustSignatureHelp,
} from "../utils/rust/compileRust";
import { Page, Router } from "../ui/Router";
import { openScripts } from "./EditorData";
import type { ContentFilePath } from "../Paths/ContentFile";

export class ScriptEditor {
  // Currently, this object is only used for initialization.
  isInitialized = false;
  initialize() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    // populate API keys for adding tokenization
    const apiKeys: string[] = [];
    const api = { args: [], pid: 1, enums, ...ns };
    const hiddenAPI = NetscriptExtra();
    function populate(apiLayer: object = api) {
      for (const [apiKey, apiValue] of Object.entries(apiLayer)) {
        if (apiLayer === api && apiKey in hiddenAPI) continue;
        apiKeys.push(apiKey);
        if (typeof apiValue === "object") {
          populate(apiValue as object);
        }
      }
    }
    populate();
    // Add api keys to tokenization
    (async function () {
      // We have to improve the default js language otherwise theme sucks
      const jsLanguage = monaco.languages.getLanguages().find((l) => l.id === "javascript");
      if (!jsLanguage) {
        return;
      }
      const loader = await jsLanguage.loader();
      // replaced the bare tokens with regexes surrounded by \b, e.g. \b{token}\b which matches a word-break on either side
      // this prevents the highlighter from highlighting pieces of variables that start with a reserved token name
      loader.language.tokenizer.root.unshift([new RegExp("\\bns\\b"), { token: "ns" }]);
      for (const symbol of apiKeys)
        loader.language.tokenizer.root.unshift([new RegExp(`\\b${symbol}\\b`), { token: "netscriptfunction" }]);
      const otherKeywords = ["let", "const", "var", "function", "arguments"];
      const otherKeyvars = ["true", "false", "null", "undefined"];
      otherKeywords.forEach((k) =>
        loader.language.tokenizer.root.unshift([new RegExp(`\\b${k}\\b`), { token: "otherkeywords" }]),
      );
      otherKeyvars.forEach((k) =>
        loader.language.tokenizer.root.unshift([new RegExp(`\\b${k}\\b`), { token: "otherkeyvars" }]),
      );
      loader.language.tokenizer.root.unshift([new RegExp("\\bthis\\b"), { token: "this" }]);
    })().catch((e) => exceptionAlert(e));

    for (const [language, languageDefaults, getLanguageWorker] of [
      ["javascript", monaco.typescript.javascriptDefaults, monaco.typescript.getJavaScriptWorker],
      ["typescript", monaco.typescript.typescriptDefaults, monaco.typescript.getTypeScriptWorker],
    ] as const) {
      languageDefaults.setCompilerOptions({
        ...languageDefaults.getCompilerOptions(),
        // We allow direct importing of `.ts`/`.tsx` files, so tell the typescript language server that.
        allowImportingTsExtensions: true,
        // We use file-at-a-time transpiler. See https://www.typescriptlang.org/tsconfig/#isolatedModules
        isolatedModules: true,
        // We use the classic (i.e. `React.createElement`:) react runtime.
        jsx: monaco.typescript.JsxEmit.React,
        // We define `React` and `ReactDOM` as globals. Don't mark using them as errors.
        allowUmdGlobalAccess: true,
        // Enable strict typechecking.
        // Note that checking in javascript is disabled by default but can be enabled via `// @ts-check`.
        // This enables strictNullChecks, which impacts reported types, even in javascript.
        strict: true,
        noImplicitAny: language === "typescript",
        noImplicitReturns: true,
        // Allow processing of javascript files, for handling cross-language imports.
        allowJs: true,
      });
      languageDefaults.setDiagnosticsOptions({
        ...languageDefaults.getDiagnosticsOptions(),
        // Show semantic errors, even in javascript.
        // Note that this will only happen if checking is enabled in javascript (e.g. by `// @ts-check`)
        noSemanticValidation: false,
        // Ignore these errors in the editor:
        diagnosticCodesToIgnore: [
          // We define `React` and `ReactDOM` as globals. Don't mark using them as errors.
          // Even though we set allowUmdGlobalAccess, it still shows a warning (instead of an error).
          // - 'React' refers to a UMD global, but the current file is a module. Consider adding an import instead.(2686)
          2686,
        ],
      });

      //  Sync all javascript and typescript text models to both language servers.
      //
      // `monaco.languages.typescript.get{Java,Type}ScriptWorker` returns a promise that
      // fires with a function that takes a list of `monaco.Uri`s and sync's them with the
      // worker. (It also returns the worker, but we don't care about that.) However, it
      // returns a reject promise if the language worker is not loaded yet, so we wait to
      // call it until the language gets loaded.
      const languageWorker = new Promise<(...uris: monaco.Uri[]) => unknown>((resolve) =>
        monaco.languages.onLanguage(language, () => {
          getLanguageWorker()
            .then(resolve)
            .catch((error) => exceptionAlert(error));
        }),
      );
      // Whenever a model is created, arrange for it to be synced to the language server.
      monaco.editor.onDidCreateModel((model) => {
        if (language === "typescript" && isLegacyScript(model.uri.path)) {
          // Don't sync legacy scripts to typescript worker.
          return;
        }
        if (["javascript", "typescript"].includes(model.getLanguageId())) {
          languageWorker.then((resolve) => resolve(model.uri)).catch((error) => exceptionAlert(error));
        }
      });
    }

    monaco.json.jsonDefaults.setModeConfiguration({
      ...monaco.json.jsonDefaults.modeConfiguration,
      //completion should be disabled because the
      //json language server tries to load a schema by default
      completionItems: false,
    });

    monaco.css.cssDefaults.setModeConfiguration({
      ...monaco.css.cssDefaults.modeConfiguration,
    });

    // Rust: hover and completion from CarciniScript's type checker. Models are named
    // `<hostname>/<path>`; the server's other scripts resolve `mod` declarations.
    const rustFile = (model: monaco.editor.ITextModel) => {
      const path = model.uri.path.replace(/^\//, "");
      const slash = path.indexOf("/");
      return { filename: path.slice(slash + 1), scripts: GetServer(path.slice(0, slash))?.scripts };
    };
    const kinds = monaco.languages.CompletionItemKind;
    const rustCompletionKinds = {
      method: kinds.Method,
      field: kinds.Field,
      function: kinds.Function,
      variable: kinds.Variable,
      struct: kinds.Struct,
      enum: kinds.Enum,
      trait: kinds.Interface,
      constant: kinds.Constant,
      module: kinds.Module,
    };
    monaco.languages.registerSignatureHelpProvider("rust", {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp(model, position) {
        const { filename, scripts } = rustFile(model);
        const help = getRustSignatureHelp(model.getValue(), filename, position.lineNumber, position.column, scripts);
        if (!help) return null;
        return {
          value: {
            signatures: [
              {
                label: help.label,
                documentation: help.documentation ? { value: help.documentation } : undefined,
                parameters: help.params.map((p) => ({ label: p })),
              },
            ],
            activeSignature: 0,
            activeParameter: help.active,
          },
          dispose: () => undefined,
        };
      },
    });
    monaco.languages.registerHoverProvider("rust", {
      provideHover(model, position) {
        const { filename, scripts } = rustFile(model);
        const h = getRustHover(model.getValue(), filename, position.lineNumber, position.column, scripts);
        if (!h) return null;
        return {
          range: new monaco.Range(h.line, h.column, h.endLine, h.endColumn),
          contents: [{ value: h.contents }],
        };
      },
    });
    monaco.languages.registerCompletionItemProvider("rust", {
      triggerCharacters: ["."],
      provideCompletionItems(model, position) {
        const { filename, scripts } = rustFile(model);
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const items = getRustCompletions(model.getValue(), filename, position.lineNumber, position.column, scripts);
        return {
          suggestions: items.map((c) => ({
            label: c.label,
            kind: rustCompletionKinds[c.kind],
            detail: c.detail,
            documentation: c.documentation ? { value: c.documentation } : undefined,
            insertText: c.label,
            range,
          })),
        };
      },
    });

    // Go to definition, references and rename. Another script's model has the URI
    // `/<hostname>/<path>`, like the open tabs' models.
    const otherFile = (model: monaco.editor.ITextModel, file: string) =>
      model.uri.with({ path: `/${model.uri.path.replace(/^\//, "").split("/")[0]}/${file}` });
    monaco.languages.registerDefinitionProvider("rust", {
      provideDefinition(model, position) {
        const { filename, scripts } = rustFile(model);
        const d = getRustDefinition(model.getValue(), filename, position.lineNumber, position.column, scripts);
        if (!d) return null;
        const uri = d.file === filename ? model.uri : otherFile(model, d.file);
        return { uri, range: new monaco.Range(d.line, d.column, d.endLine, d.endColumn) };
      },
    });
    monaco.languages.registerReferenceProvider("rust", {
      provideReferences(model, position) {
        const { filename, scripts } = rustFile(model);
        return getRustReferences(model.getValue(), filename, position.lineNumber, position.column, scripts).map(
          (l) => ({
            uri: l.file === filename ? model.uri : otherFile(model, l.file),
            range: new monaco.Range(l.line, l.column, l.endLine, l.endColumn),
          }),
        );
      },
    });
    monaco.languages.registerRenameProvider("rust", {
      provideRenameEdits(model, position, newName) {
        const { filename, scripts } = rustFile(model);
        const spots = getRustRename(model.getValue(), filename, position.lineNumber, position.column, newName, scripts);
        if (spots.length === 0) {
          return { edits: [], rejectReason: "Only a name defined in your scripts can be renamed, to a valid identifier" };
        }
        const range = (l: (typeof spots)[number]) => new monaco.Range(l.line, l.column, l.endLine, l.endColumn);
        // Other scripts: their open tab's model, else the script on the server, changed right away.
        const hostname = model.uri.path.replace(/^\//, "").split("/")[0];
        const server = GetServer(hostname);
        for (const file of new Set(spots.filter((l) => l.file !== filename).map((l) => l.file))) {
          const edits = spots.filter((l) => l.file === file).map((l) => ({ range: range(l), text: newName }));
          const open = monaco.editor.getModel(otherFile(model, file));
          if (open) {
            open.pushEditOperations([], edits, () => null);
            continue;
          }
          const script = server?.scripts.get(file as ScriptFilePath);
          if (!server || !script) continue;
          const temp = monaco.editor.createModel(script.code, "rust");
          temp.applyEdits(edits);
          server.writeToScriptFile(file as ScriptFilePath, temp.getValue());
          temp.dispose();
        }
        return {
          edits: spots
            .filter((l) => l.file === filename)
            .map((l) => ({
              resource: model.uri,
              versionId: model.getVersionId(),
              textEdit: { range: range(l), text: newName },
            })),
        };
      },
    });
    // A definition in another script opens it in a new tab (or switches to it).
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const path = resource.path.replace(/^\//, "");
        const slash = path.indexOf("/");
        const hostname = path.slice(0, slash);
        const file = path.slice(slash + 1) as ContentFilePath;
        const server = GetServer(hostname);
        const script = server?.scripts.get(file as ScriptFilePath);
        if (!server || !script) return false;
        const at =
          selectionOrPosition && "startLineNumber" in selectionOrPosition
            ? new monaco.Position(selectionOrPosition.startLineNumber, selectionOrPosition.startColumn)
            : selectionOrPosition && "lineNumber" in selectionOrPosition
            ? new monaco.Position(selectionOrPosition.lineNumber, selectionOrPosition.column)
            : null;
        const open = openScripts.find((s) => s.path === file && s.hostname === hostname);
        if (open && at) open.lastPosition = at;
        Router.toPage(Page.ScriptEditor, {
          files: new Map([[file, script.code]]),
          options: { hostname, vim: Settings.MonacoDefaultToVim },
        });
        return true;
      },
    });

    // Load themes
    loadThemes(monaco.editor.defineTheme);
    monaco.editor.defineTheme("customTheme", makeTheme(Settings.EditorTheme));
  }
}

export const scriptEditor = new ScriptEditor();
