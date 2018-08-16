import * as fs from 'fs';
import * as path from "path";
import * as vscode from "vscode";
import { reporter } from '../telemetry/telemetry';
import { OS, promptForPort } from './config-utils';

function genDockerCompose(serviceName: string, platform: string, os: string, portProtheusWebApp: string): string {

    return `version: '3.2'

services:
    license:
        image: thfservices.totvs.com.br/dcp-license
        container_name: license

    appserver:
        image: thfservices.totvs.com.br/dcp-appserver:x32_13_2
        container_name: appserver
        ports:
        - 8080:80   # WebAPP
        - ${portProtheusWebApp}:8081 # Porta para acesso TCP
        - 8084:8084 # Porta para o REST
        environment:
        # - ENVIRONMENT_SPECIALKEY=dcp
        - GENERAL_BUILDKILLUSERS=1
        # - LICENSECLIENT_SERVER=license.totvs.io
        # - LICENSECLIENT_PORT=8089
        - REST=false
        volumes:
        - rpo_data:/apo
        # tmpfs:
        #   - /run
        #   - /tmp
        # ulimits:
        #   # Single number or mapping with soft + hard limits
        #   nproc: 65535
        #   nofile:
        #     soft: 20000
        #     hard: 40000

    dbaccess:
        image: thfservices.totvs.com.br/dcp-dbaccess:x64_published
        container_name: dbaccess

    database:
        image: thfservices.totvs.com.br/dcp-database:postgres_full
        container_name: database
        volumes:
        - db_data:/var/lib/postgresql/data

volumes:
    rpo_data:
    db_data:`;
}

interface PackageJson {
    npmStart: boolean, //has npm start
    cmd: string,
    fullCommand: string, //full command
    author: string,
    version: string,
    artifactName: string
}

async function getPackageJson(folderPath: string): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(new vscode.RelativePattern(folderPath, 'package.json'), null, 1, null);
}

function getDefaultPackageJson(): PackageJson {
    return {
        npmStart: true,
        fullCommand: 'npm start',
        cmd: 'npm start',
        author: 'author',
        version: '0.0.1',
        artifactName: ''
    };
}

async function readPackageJson(folderPath: string): Promise<PackageJson> {
    // open package.json and look for main, scripts start
    const uris: vscode.Uri[] = await getPackageJson(folderPath);
    let pkg: PackageJson = getDefaultPackageJson(); //default

    if (uris && uris.length > 0) {
        const json = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));

        if (json.scripts && json.scripts.start) {
            pkg.npmStart = true;
            pkg.fullCommand = json.scripts.start;
            pkg.cmd = 'npm start';
        } else if (json.main) {
            pkg.npmStart = false;
            pkg.fullCommand = 'node' + ' ' + json.main;
            pkg.cmd = pkg.fullCommand;
        } else {
            pkg.fullCommand = '';
        }

        if (json.author) {
            pkg.author = json.author;
        }

        if (json.version) {
            pkg.version = json.version;
        }
    }

    return pkg;
}

type GeneratorFunction = (serviceName: string, platform: string, os: string, port: string, packageJson?: PackageJson) => string;

const DOCKER_FILE_TYPES: { [key: string]: GeneratorFunction } = {
    'docker-compose.yml': genDockerCompose
    // 'docker-compose.debug.yml': genDockerCom
};

const YES_OR_NO_PROMPT: vscode.MessageItem[] = [
    {
        "title": 'Yes',
        "isCloseAffordance": false
    },
    {
        "title": 'No',
        "isCloseAffordance": true
    }
];

export async function configure(folderPath?: string): Promise<void> {
    if (!folderPath) {
        let folder: vscode.WorkspaceFolder;
        folder = vscode.workspace.workspaceFolders[0];

        if (!folder) {
            if (!vscode.workspace.workspaceFolders) {
                throw new Error('Docker files can only be generated if VS Code is opened on a folder.');
            } else {
                throw new Error('Docker files can only be generated if a workspace folder is picked in VS Code.');
            }
        }

        folderPath = folder.uri.fsPath;
    }

    const platformType = 'Other';

    let os: OS | undefined;

    let port = await promptForPort(8081);

    let serviceName: string;

    serviceName = path.basename(folderPath).toLowerCase();

    let pkg: PackageJson = getDefaultPackageJson();

    pkg = await readPackageJson(folderPath);

    await Promise.all(Object.keys(DOCKER_FILE_TYPES).map(async (fileName) => {
        if (platformType.toLowerCase().includes('.net') && fileName.includes('docker-compose')) {
            return;
        }

        return createWorkspaceFileIfNotExists(fileName, DOCKER_FILE_TYPES[fileName]);
    }));

    if (reporter) {
        reporter.sendTelemetryEvent('command', {
            command: 'vscode-docker.configure',
            platformType
        });
    }

    async function createWorkspaceFileIfNotExists(fileName: string, generatorFunction: GeneratorFunction): Promise<void> {
        console.log('criando workspace');
        const workspacePath = path.join(folderPath, fileName);
        if (fs.existsSync(workspacePath)) {
            const item: vscode.MessageItem = await vscode.window.showErrorMessage(`A ${fileName} already exists. Would you like to override it?`, ...YES_OR_NO_PROMPT);
            if (item.title.toLowerCase() === 'yes') {
                fs.writeFileSync(workspacePath, generatorFunction(serviceName, platformType, os, port, pkg), { encoding: 'utf8' });
            }
        } else {
            fs.writeFileSync(workspacePath, generatorFunction(serviceName, platformType, os, port, pkg), { encoding: 'utf8' });
        }
    }
}
