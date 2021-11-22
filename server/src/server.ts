// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as PQLS from "@microsoft/powerquery-language-services";
import * as PQP from "@microsoft/powerquery-parser";
// tslint:disable-next-line: no-submodule-imports
import * as LS from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { StandardLibraryUtils } from "./standardLibrary";

const LanguageId: string = "powerquery";

interface ServerSettings {
    checkForDuplicateIdentifiers: boolean;
    locale: string;
    maintainWorkspaceCache: boolean;
}

const connectionOptions: LS.ConnectionOptions = {
    cancellationStrategy: LS.CancellationStrategy.Message,
};

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection: LS.Connection = LS.createConnection(LS.ProposedFeatures.all, connectionOptions);
const documents: LS.TextDocuments<TextDocument> = new LS.TextDocuments(TextDocument);

let serverSettings: ServerSettings;

connection.onInitialize(() => {
    return {
        capabilities: {
            textDocumentSync: LS.TextDocumentSyncKind.Incremental,
            documentFormattingProvider: true,
            completionProvider: {
                resolveProvider: false,
            },
            documentSymbolProvider: {
                workDoneProgress: false,
            },
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ["(", ","],
            },
        },
    };
});

connection.onInitialized(() => {
    connection.workspace.getConfiguration({ section: "powerquery" }).then(config => {
        serverSettings = {
            checkForDuplicateIdentifiers: true,
            locale: config?.general?.locale ?? PQP.DefaultLocale,
            maintainWorkspaceCache: true,
        };
    });
});

documents.onDidClose(event => {
    // Clear any errors associated with this file
    connection.sendDiagnostics({
        uri: event.document.uri,
        diagnostics: [],
    });
    PQLS.documentClosed(event.document);
});

documents.onDidChangeContent(event => {
    // TODO: pass actual incremental changes into the workspace cache
    PQLS.documentClosed(event.document);

    validateDocument(event.document).catch(err =>
        connection.console.error(`validateDocument err: ${JSON.stringify(err, undefined, 4)}`),
    );
});

async function validateDocument(document: TextDocument): Promise<void> {
    const validationToken: PQP.ICancellationToken = createValidationCancellationToken(document.uri, document.version);

    const result: PQLS.ValidationResult = PQLS.validate(
        document,
        createValidationSettings(getLocalizedStandardLibrary(), validationToken),
    );

    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: result.diagnostics,
    });
}

connection.onDocumentFormatting((documentfomattingParams: LS.DocumentFormattingParams): LS.TextEdit[] => {
    const maybeDocument: TextDocument | undefined = documents.get(documentfomattingParams.textDocument.uri);
    if (maybeDocument === undefined) {
        return [];
    }
    const document: TextDocument = maybeDocument;

    try {
        return PQLS.tryFormat(document, documentfomattingParams.options, serverSettings.locale ?? PQP.DefaultLocale);
    } catch (err) {
        const error: Error = err as Error;
        const errorMessage: string = error.message;

        let userMessage: string;
        // An already localized message was returned.
        if (errorMessage) {
            userMessage = errorMessage;
        } else {
            userMessage = "An unknown error occured during formatting.";
        }

        connection.window.showErrorMessage(userMessage);
        return [];
    }
});

connection.onCompletion(
    async (
        textDocumentPosition: LS.TextDocumentPositionParams,
        token: LS.CancellationToken,
    ): Promise<LS.CompletionItem[]> => {
        const document: TextDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);
        if (document) {
            const analysis: PQLS.Analysis = createAnalysis(document, textDocumentPosition.position, token);

            return analysis.getAutocompleteItems().catch(err => {
                connection.console.error(`onCompletion error ${JSON.stringify(err, undefined, 4)}`);
                return [];
            });
        }

        return [];
    },
);

connection.onDocumentSymbol(
    async (
        documentSymbolParams: LS.DocumentSymbolParams,
        token: LS.CancellationToken,
    ): Promise<LS.DocumentSymbol[] | undefined> => {
        const document: TextDocument | undefined = documents.get(documentSymbolParams.textDocument.uri);
        if (document) {
            return PQLS.getDocumentSymbols(
                document,
                createParserSettingsWithCancellationToken(token),
                serverSettings.maintainWorkspaceCache ?? false,
            );
        }

        return undefined;
    },
);

connection.onHover(
    async (
        textDocumentPosition: LS.TextDocumentPositionParams,
        _token: LS.CancellationToken,
    ): Promise<LS.Hover | LS.ResponseError<void>> => {
        const emptyHover: LS.Hover = {
            range: undefined,
            contents: [],
        };

        const document: TextDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);
        if (document === undefined) {
            return emptyHover;
        }

        const token: PQP.ICancellationToken = createValidationCancellationToken(document.uri, document.version);

        const analysis: PQLS.Analysis = createAnalysis(document, textDocumentPosition.position, token);

        // if (token.isCancellationRequested) {
        //     connection.console.info(`onHover action was cancelled`);
        //     return new LS.ResponseError(LS.LSPErrorCodes.RequestCancelled, "Request got cancelled");
        // }

        return analysis.getHover().catch(err => {
            connection.console.error(`onHover error ${JSON.stringify(err, undefined, 4)}`);
            return emptyHover;
        });

        // // TODO: is it safer to return the empty value rather than an error response?
        // return handleServerResponse("onHover", analysis.getHover, emptyHover, token);
    },
);

connection.onSignatureHelp(
    async (
        textDocumentPosition: LS.TextDocumentPositionParams,
        token: LS.CancellationToken,
    ): Promise<LS.SignatureHelp> => {
        const emptySignatureHelp: LS.SignatureHelp = {
            signatures: [],
            // tslint:disable-next-line: no-null-keyword
            activeParameter: null,
            activeSignature: 0,
        };

        const document: TextDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);
        if (document) {
            const analysis: PQLS.Analysis = createAnalysis(document, textDocumentPosition.position, token);

            return analysis.getSignatureHelp().catch(err => {
                connection.console.error(`onSignatureHelp error ${JSON.stringify(err, undefined, 4)}`);
                return emptySignatureHelp;
            });
        }

        return emptySignatureHelp;
    },
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

function createAnalysis(
    document: TextDocument,
    position: PQLS.Position,
    token: LS.CancellationToken | PQP.ICancellationToken,
): PQLS.Analysis {
    const localizedStandardLibrary: PQLS.Library.ILibrary = getLocalizedStandardLibrary();

    return PQLS.AnalysisUtils.createAnalysis(
        document,
        createAnalysisSettings(localizedStandardLibrary, token),
        position,
    );
}

function createAnalysisSettings(
    library: PQLS.Library.ILibrary,
    token: LS.CancellationToken | PQP.ICancellationToken,
): PQLS.AnalysisSettings {
    return {
        createInspectionSettingsFn: () => createInspectionSettings(library, token),
        library,
        maintainWorkspaceCache: serverSettings.maintainWorkspaceCache,
    };
}

function getLocalizedStandardLibrary(): PQLS.Library.ILibrary {
    return StandardLibraryUtils.getOrCreateStandardLibrary(serverSettings.locale);
}

function createParserSettingsWithCancellationToken(token: LS.CancellationToken | PQP.ICancellationToken): PQP.Settings {
    return {
        ...PQP.DefaultSettings,
        maybeCancellationToken: "isCancellationRequested" in token ? wrapCancellationToken(token) : token,
    };
}

function createInspectionSettings(
    library: PQLS.Library.ILibrary,
    token: LS.CancellationToken | PQP.ICancellationToken,
): PQLS.InspectionSettings {
    return PQLS.InspectionUtils.createInspectionSettings(
        {
            ...createParserSettingsWithCancellationToken(token),
            locale: serverSettings.locale,
        },
        library.externalTypeResolver,
    );
}

function createValidationSettings(
    library: PQLS.Library.ILibrary,
    token: LS.CancellationToken | PQP.ICancellationToken,
): PQLS.ValidationSettings {
    return PQLS.ValidationSettingsUtils.createValidationSettings(
        createInspectionSettings(library, token),
        LanguageId,
        serverSettings.checkForDuplicateIdentifiers,
    );
}

function wrapCancellationToken(token: LS.CancellationToken): PQP.ICancellationToken {
    return {
        isCancelled: () => token.isCancellationRequested,
        cancel: () => {
            /**/
        },
        throwIfCancelled: () => false,
    };
}

function createValidationCancellationToken(documentUrl: string, documentVersion: number): PQP.ICancellationToken {
    return {
        isCancelled: () => {
            connection.console.error("isCancelled");
            return documents.get(documentUrl)?.version !== documentVersion;
        },
        cancel: () => {
            /**/
        },
        throwIfCancelled: () => false,
    };
}

// async function handleServerResponse<T>(
//     id: string,
//     action: () => Promise<T>,
//     defaultValue: T,
//     token: LS.CancellationToken,
// ): Promise<T | LS.ResponseError<void>> {
//     if (token.isCancellationRequested) {
//         connection.console.info(`${id} action was cancelled`);
//         return new LS.ResponseError(LS.LSPErrorCodes.RequestCancelled, "Request got cancelled");
//     }

//     return action().catch(err => {
//         connection.console.error(`${id} error ${JSON.stringify(err, undefined, 4)}`);
//         connection.console.error(`cancel token value ${token.isCancellationRequested}`);
//         return defaultValue;
//     });
// }
