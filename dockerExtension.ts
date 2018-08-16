/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AzureUserInput, createTelemetryReporter, registerCommand, registerUIExtensionVariables, UserCancelledError } from 'vscode-azureextensionui';
import { ConfigurationParams, DidChangeConfigurationNotification, DocumentSelector, LanguageClient, LanguageClientOptions, Middleware, ServerOptions, TransportKind } from 'vscode-languageclient/lib/main';
import { docker } from './commands/utils/docker-endpoint';
import { DefaultTerminalProvider } from './commands/utils/TerminalProvider';
import { DockerDebugConfigProvider } from './configureWorkspace/configDebugProvider';
import { configure } from './configureWorkspace/configure';
import { DockerComposeCompletionItemProvider } from './dockerCompose/dockerComposeCompletionItemProvider';
import { DockerComposeHoverProvider } from './dockerCompose/dockerComposeHoverProvider';
import composeVersionKeys from './dockerCompose/dockerComposeKeyInfo';
import { DockerComposeParser } from './dockerCompose/dockerComposeParser';
import { DockerfileCompletionItemProvider } from './dockerfile/dockerfileCompletionItemProvider';
import DockerInspectDocumentContentProvider, { SCHEME as DOCKER_INSPECT_SCHEME } from './documentContentProviders/dockerInspect';
import * as util from "./explorer/deploy/util";
import { DockerExplorerProvider } from './explorer/dockerExplorer';
import { ext } from "./extensionVariables";
import { initializeTelemetryReporter, reporter } from './telemetry/telemetry';
import { AzureAccount } from './typings/azure-account.api';

export const FROM_DIRECTIVE_PATTERN = /^\s*FROM\s*([\w-\/:]*)(\s*AS\s*[a-z][a-z0-9-_\\.]*)?$/i;
export const COMPOSE_FILE_GLOB_PATTERN = '**/[dD]ocker-[cC]ompose*.{yaml,yml}';
export const DOCKERFILE_GLOB_PATTERN = '**/{*.dockerfile,[dD]ocker[fF]ile}';

export let dockerExplorerProvider: DockerExplorerProvider;

export type KeyInfo = { [keyName: string]: string; };

export interface ComposeVersionKeys {
    All: KeyInfo,
    v1: KeyInfo,
    v2: KeyInfo
}

let client: LanguageClient;

const DOCUMENT_SELECTOR: DocumentSelector = [
    { language: 'dockerfile', scheme: 'file' }
];

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    const installedExtensions: any[] = vscode.extensions.all;
    const outputChannel = util.getOutputChannel();
    let azureAccount: AzureAccount;

    // Set up extension variables
    registerUIExtensionVariables(ext);
    if (!ext.ui) {
        // This allows for standard interactions with the end user (as opposed to test input)
        ext.ui = new AzureUserInput(ctx.globalState);
    }
    ext.context = ctx;
    ext.outputChannel = outputChannel;
    if (!ext.terminalProvider) {
        ext.terminalProvider = new DefaultTerminalProvider();
    }
    initializeTelemetryReporter(createTelemetryReporter(ctx));
    ext.reporter = reporter;

    // tslint:disable-next-line:prefer-for-of // Grandfathered in
    for (let i = 0; i < installedExtensions.length; i++) {
        const extension = installedExtensions[i];
        if (extension.id === 'ms-vscode.azure-account') {
            try {
                azureAccount = await extension.activate();
            } catch (error) {
                console.log('Failed to activate the Azure Account Extension: ' + error);
            }
            break;
        }
    }

    dockerExplorerProvider = new DockerExplorerProvider(azureAccount);
    vscode.window.registerTreeDataProvider('dockerExplorer', dockerExplorerProvider);
    registerCommand('vscode-docker.explorer.refresh', () => dockerExplorerProvider.refresh());

    ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(DOCUMENT_SELECTOR, new DockerfileCompletionItemProvider(), '.'));

    const YAML_MODE_ID: vscode.DocumentFilter = { language: 'yaml', scheme: 'file', pattern: COMPOSE_FILE_GLOB_PATTERN };
    let yamlHoverProvider = new DockerComposeHoverProvider(new DockerComposeParser(), composeVersionKeys.All);
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(YAML_MODE_ID, yamlHoverProvider));
    ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(YAML_MODE_ID, new DockerComposeCompletionItemProvider(), '.'));

    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DOCKER_INSPECT_SCHEME, new DockerInspectDocumentContentProvider()));

    registerCommand('vscode-docker.configure', configure);

    ctx.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('docker', new DockerDebugConfigProvider()));

    activateLanguageClient(ctx);
}

export function deactivate(): Thenable<void> {
    if (!client) {
        return undefined;
    }
    // perform cleanup
    Configuration.dispose();
    return client.stop();
}

namespace Configuration {

    let configurationListener: vscode.Disposable;

    export function computeConfiguration(params: ConfigurationParams): vscode.WorkspaceConfiguration[] {
        if (!params.items) {
            return null;
        }
        let result: vscode.WorkspaceConfiguration[] = [];
        for (let item of params.items) {
            let config = null;

            if (item.scopeUri) {
                config = vscode.workspace.getConfiguration(item.section, client.protocol2CodeConverter.asUri(item.scopeUri));
            } else {
                config = vscode.workspace.getConfiguration(item.section);
            }
            result.push(config);
        }
        return result;
    }

    export function initialize(): void {
        configurationListener = vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            // notify the language server that settings have change
            client.sendNotification(DidChangeConfigurationNotification.type, { settings: null });

            // Update endpoint and refresh explorer if needed
            if (e.affectsConfiguration('docker')) {
                docker.refreshEndpoint();
                vscode.commands.executeCommand("vscode-docker.explorer.refresh");
            }
        });
    }

    export function dispose(): void {
        if (configurationListener) {
            // remove this listener when disposed
            configurationListener.dispose();
        }
    }
}

function activateLanguageClient(ctx: vscode.ExtensionContext): void {
    let serverModule = ctx.asAbsolutePath(path.join("node_modules", "dockerfile-language-server-nodejs", "lib", "server.js"));
    let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc, args: ["--node-ipc"] },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    }

    let middleware: Middleware = {
        workspace: {
            configuration: Configuration.computeConfiguration
        }
    };

    let clientOptions: LanguageClientOptions = {
        documentSelector: DOCUMENT_SELECTOR,
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        },
        middleware: middleware as Middleware
    }

    client = new LanguageClient("dockerfile-langserver", "Dockerfile Language Server", serverOptions, clientOptions);
    // tslint:disable-next-line:no-floating-promises
    client.onReady().then(() => {
        // attach the VS Code settings listener
        Configuration.initialize();
    });
    client.start();
}
