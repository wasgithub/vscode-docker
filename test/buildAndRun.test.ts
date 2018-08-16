/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';
import * as assertEx from './assertEx';
import * as vscode from 'vscode';
import { commands } from 'vscode';
import { Uri } from 'vscode';
import * as fse from 'fs-extra';
import * as AdmZip from 'adm-zip';
import * as path from 'path';
import { ext } from '../extensionVariables';
import { Suite } from 'mocha';
import { configure } from '../configureWorkspace/configure';
import { TestUserInput } from 'vscode-azureextensionui';
import { getTestRootFolder, constants } from './global.test';
import { httpsRequestBinary } from '../utils/httpRequest';
import { TestTerminalProvider } from '../commands/utils/TerminalProvider';
import { openShellContainer } from '../commands/open-shell-container';

let testRootFolder: string = getTestRootFolder();

/**
 * Downloads and then extracts only a specific subfolder and its folders.
 */
async function unzipFileFromUrl(uri: Uri, sourceFolderInZip: string, outputFolder: string): Promise<void> {
    let zipContents = await httpsRequestBinary(uri.toString());
    let zip = new AdmZip(zipContents);
    await extractFolderTo(zip, sourceFolderInZip, outputFolder);
}

/**
 * Extracts only a specific folder and its subfolders.
 * Not using AdmZip.extractAllTo because depending on the .zip file we may end up with an extraneous top-level folder
 */
async function extractFolderTo(zip: AdmZip, sourceFolderInZip: string, outputFolder: string): Promise<void> {
    if (!(sourceFolderInZip.endsWith('/') || sourceFolderInZip.endsWith('\\'))) {
        sourceFolderInZip += '/';
    }

    var zipEntries = zip.getEntries();
    for (let entry of zipEntries) {
        if (entry.entryName.startsWith(sourceFolderInZip)) {
            let relativePath = entry.entryName.slice(sourceFolderInZip.length);
            if (!relativePath) {
                // root folder
                continue;
            }

            let outPath = path.join(outputFolder, relativePath);
            if (entry.isDirectory) {
                //console.log(`Folder: ${entry.entryName}`);
                await fse.mkdirs(outPath)
            } else {
                //console.log(`File: ${entry.entryName}`);
                let data: Buffer = entry.getData();
                await fse.writeFile(outPath, data);
            }
        }
    }
}

suite("Build Image", function (this: Suite): void {
    this.timeout(Math.max(60 * 1000, this.timeout()));

    const outputChannel: vscode.OutputChannel = vscode.window.createOutputChannel('Docker extension tests');
    ext.outputChannel = outputChannel;

    async function testConfigureAndBuildImage(
        platform,
        configureInputs: (string | undefined)[],
        buildInputs: (string | undefined)[]
    ): Promise<void> {
        // Set up simulated user input
        configureInputs.unshift(platform);
        ext.ui = new TestUserInput(configureInputs);
        let testTerminalProvider = new TestTerminalProvider();
        ext.terminalProvider = testTerminalProvider;

        await configure(testRootFolder);
        assert.equal(configureInputs.length, 0, 'Not all inputs were used for configure docker files');

        // Build image
        ext.ui = new TestUserInput(buildInputs);
        let dockerFile = Uri.file(path.join(testRootFolder, 'Dockerfile'));
        await commands.executeCommand('vscode-docker.image.build', dockerFile);
        assert.equal(configureInputs.length, 0, 'Not all inputs were used for Build Image');

        let { outputText, errorText } = await testTerminalProvider.currentTerminal.exit();

        console.log("=== OUTPUT BEGIN ================================");
        console.log(outputText ? outputText : '(NONE)');
        console.log("=== OUTPUT END ==================================");

        console.log("=== ERROR OUTPUT BEGIN ================================");
        console.log(errorText ? errorText : '(NONE)');
        console.log("=== ERROR OUTPUT END ==================================");

        assert.equal(errorText, '', 'Expected no errors from Build Image');
        assertEx.assertContains(outputText, 'Successfully built');
        assertEx.assertContains(outputText, 'Successfully tagged')
    }

    function testInEmptyFolder(name: string, func: () => Promise<void>): void {
        test(name, async () => {
            // Delete everything in the root testing folder
            assert(path.basename(testRootFolder) === constants.testOutputName, "Trying to delete wrong folder");;
            await fse.emptyDir(testRootFolder);
            await func();
        });
    }

    // Go

    testInEmptyFolder("Go", async () => {
        let uri = 'https://codeload.github.com/cloudfoundry-community/simple-go-web-app/zip/master'; // https://github.com/cloudfoundry-community/simple-go-web-app/archive/master.zip
        await unzipFileFromUrl(Uri.parse(uri), 'simple-go-web-app-master', testRootFolder);
        await testConfigureAndBuildImage(
            'Go',
            ['3001'],
            ['testoutput:latest']
        );
    });

    // NEEDED TESTS:
    // 'Java'
    // '.NET Core Console'
    // 'ASP.NET Core'
    // 'Node.js'
    // 'Python'
    // 'Ruby'

});
