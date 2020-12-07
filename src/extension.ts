/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as Net from 'net';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { platform } from 'process';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { MockDebugSession } from './monkeycDebug';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { readFile, writeFile, createReadStream } from 'fs';
var path = require('path');
const readline = require('readline');


interface UnitTest {
	name: string;
	result: string;
	time: string;
	assert: string;
}


/*
 * The compile time flag 'runMode' controls how the debug adapter is run.
 * Please note: the test suite only supports 'external' mode.
 */
const runMode: 'external' | 'server' | 'namedPipeServer' | 'inline' = 'inline';

export function activate(context: vscode.ExtensionContext) {
	let currentPanel: vscode.WebviewPanel | undefined = undefined;
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.mock-debug.runEditorContents', (resource: vscode.Uri) => {
			vscode.debug.startDebugging(undefined, {
				type: 'mock',
				name: 'Run Editor Contents',
				request: 'launch',
				program: resource.fsPath
			}, {
				//noDebug: true
			});
		}),
		vscode.commands.registerCommand('extension.mock-debug.debugEditorContents', (resource: vscode.Uri) => {
			vscode.debug.startDebugging(undefined, {
				type: 'mock',
				name: 'Debug Editor Contents',
				request: 'launch',
				program: resource.fsPath
			});
		}),
		vscode.commands.registerCommand('extension.mock-debug.showAsHex', (variable) => {
			vscode.window.showInformationMessage(`${variable.container.name}: ${variable.variable.name}`);
		})
	);
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.mock-debug.getSdkPath',
		() => {
			return context.globalState.get('sdkPath');
		}

	));
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.mock-debug.getProjectPath',
		() => {
			return context.globalState.get('projectPath');
		}

	));
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.mock-debug.sendMessageToWebView',
		(data) => {
			if (!currentPanel) {
				return;
			}

			// Send a message to our webview.
			// You can send any JSON serializable data.
			currentPanel.webview.postMessage(JSON.stringify(data));
		}

	));

	context.subscriptions.push(vscode.commands.registerCommand('extension.mock-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a markdown file in the workspace folder",
			value: "readme.md"
		});
	}));

	// register a configuration provider for 'mock' debug type
	const provider = new MockConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('mock', provider));

	// register a dynamic configuration provider for 'mock' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('mock', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			return [
				{
					name: "Dynamic Launch",
					request: "launch",
					type: "node",
					program: "${file}"
				},
				{
					name: "Another Dynamic Launch",
					request: "launch",
					type: "node",
					program: "${file}"
				},
				{
					name: "Mock Launch",
					request: "launch",
					type: "node",
					program: "${file}"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicate via a socket
			factory = new MockDebugAdapterServerDescriptorFactory();
			break;

		case 'namedPipeServer':
			// run the debug adapter as a server inside the extension and communicate via a named pipe (Windows) or UNIX domain socket (non-Windows)
			factory = new MockDebugAdapterNamedPipeServerDescriptorFactory();
			break;

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new InlineDebugAdapterFactory();
			break;

		case 'external': default:
			// run the debug adapter as a separate process
			factory = new DebugAdapterExecutableFactory();
			break;
	}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('mock', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	/*
	vscode.languages.registerEvaluatableExpressionProvider('markdown', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	});
	*/
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.mock-debug.config', () => {
			const panel = vscode.window.createWebviewPanel(
				'catCoding',
				'Cat Coding',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);

			panel.webview.html = getWebviewContent();

			// Handle messages from the webview
			panel.webview.onDidReceiveMessage(
				message => {
					switch (message.command) {
						case 'alert':
							context.globalState.update('sdkPath', message.text.split(' ')[0]);
							context.globalState.update('projectPath', message.text.split(' ')[1]);
							const launchFile: string[] = glob.sync(path.normalize(message.text.split(' ')[1]) + '/**/.vscode/launch.json');
							//update launch.json
							readFile(launchFile[0], 'utf8', function readFileCallback(err, data) {
								if (err) {
									console.log(err);
								} else {
									let obj = JSON.parse(data);
									obj.configurations[0].sdkPath_ = message.text.split(' ')[0];
									obj.configurations[0].projectPath_ = message.text.split(' ')[0];
									// obj.table.push({id: 2, square:3}); //add some data
									let json = JSON.stringify(obj); //convert it back to json
									writeFile(launchFile[0], json, 'utf8', () => { }); // write it back 
								}
							});
							vscode.commands.executeCommand('extension.mock-debug.getSdkPath', message.text);
					}
				},
				undefined,
				context.subscriptions
			);

		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('extension.mock-debug.UnitTests', () => {
			currentPanel = vscode.window.createWebviewPanel(
				'catCoding',
				'Cat Coding',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);

			currentPanel.webview.html = getUnitTestsWebviewContent();

			// Handle messages from the webview
			currentPanel.webview.onDidReceiveMessage(
				async message => {
					let sdkPath;
					let projectPath;
					if (await vscode.commands.executeCommand('extension.mock-debug.getSdkPath') === undefined || await vscode.commands.executeCommand('extension.mock-debug.getProjectPath') === undefined) {
						vscode.commands.executeCommand('extension.mock-debug.config');
						sdkPath = await vscode.commands.executeCommand('extension.mock-debug.getSdkPath');
						projectPath = await vscode.commands.executeCommand('extension.mock-debug.getProjectPath');
					}
					else {
						sdkPath = await vscode.commands.executeCommand('extension.mock-debug.getSdkPath');
						projectPath = await vscode.commands.executeCommand('extension.mock-debug.getProjectPath');
					}
					if (message.command === 'run-test-again') {
						let buffer;
						const cmd = spawn('cmd', ['/K'], { shell: true });
						cmd.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
						cmd.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));
						cmd.stdin.write(Buffer.from('monkeyc -d d2bravo -f "' + projectPath + '\\monkey.jungle" -o "' + projectPath + '\\bin\\WATCHFACE.prg" -y "c:\\Users\\ondre\\Desktop\\GARMIN SDK\\developer_key.der" -t\n'));
						cmd.stdin.write(Buffer.from('connectiq\n'));
						cmd.stdin.write(Buffer.from('"' + sdkPath + '\\monkeydo.bat" "' + projectPath + '\\bin\\WATCHFACE.prg" d2bravo /t ' + message.text + '\n'));
						cmd.stdin.write(Buffer.from('###\n'));
						cmd.stdout.on('data', async (data) => {
							const tests: UnitTest[] = [];
							const data_ = data.toString();
							console.log(data_);

							buffer += data;
							if (buffer.includes('###')) {

								if (buffer.includes('Executing test')) {
									const info: string[] = buffer.match(/Executing test\s(.*)...\nDEBUG\s[(](.*)[)].*\n(.*)/g);
									info.forEach(element => {
										if (element.trim().startsWith('Executing test')) {
											const unitTestInfo = element.match(/Executing test\s(.*)...\nDEBUG\s[(](.*)[)]:\s(.*)\n(.*)/);


											if (unitTestInfo) {
												const unitTest = {
													name: unitTestInfo[1],
													result: unitTestInfo[4],
													time: unitTestInfo[2],
													assert: unitTestInfo[3]
												} as UnitTest;
												tests.push(unitTest);
											}

										}
									});
									glob(projectPath + '/source/**/*.mc', {}, (err, files) => {

										files.forEach(async element => {

											const fileStream = createReadStream(element);

											const rl = readline.createInterface({
												input: fileStream,
												crlfDelay: Infinity
											});

											let lineCount = 0;
											for await (const line of rl) {
												lineCount++;
												tests.forEach(unitTest => {
													const unitTestName = unitTest.name.split('.');
													let nameWithoutClass = "";

													if (unitTestName.length > 1) {
														nameWithoutClass = unitTestName[1];
													}
													else {
														nameWithoutClass = unitTestName[0];
													}
													if (line.includes(nameWithoutClass)) {
														const additionalInfoObj = {
															additionalInfo: {
																name: unitTest.name,
																file: rl.input.path,
																line: lineCount
															}

														};
														vscode.commands.executeCommand('extension.mock-debug.sendMessageToWebView', additionalInfoObj);
													}
												});

											}

										});
										console.log(files);
									});
									vscode.commands.executeCommand('extension.mock-debug.sendMessageToWebView', tests);
									//console.log(data_);
									cmd.kill();
									buffer = '';
								}
								else {
									console.log('No unit tests found.');
								}
							}




						});


					}
					if (message.command === 'run-tests') {
						let buffer;
						const cmd = spawn('cmd', ['/K'], { shell: true });
						cmd.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
						cmd.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));
						cmd.stdin.write(Buffer.from('monkeyc -d d2bravo -f "' + projectPath + '\\monkey.jungle" -o "' + projectPath + '\\bin\\WATCHFACE.prg" -y "c:\\Users\\ondre\\Desktop\\GARMIN SDK\\developer_key.der" -t\n'));
						cmd.stdin.write(Buffer.from('connectiq\n'));
						cmd.stdin.write(Buffer.from('"' + sdkPath + '\\monkeydo.bat" "' + projectPath + '\\bin\\WATCHFACE.prg" d2bravo /t\n'));
						//cmd.stdin.write(Buffer.from('"C:\\Users\\ondre\\Desktop\\GARMIN%SDK\\connectiq-sdk-win-3.1.9-2020-06-24-1cc9d3a70\\bin\\monkeydo.bat" "C:\\Users\\ondre\\Desktop\\debuggerExtensionStart\\WATCHFACE\\bin\\WATCHFACE.prg" d2bravo /t\n'));
						cmd.stdin.write(Buffer.from('###\n'));
						//cmd.stdin.write(Buffer.from('simulator & [1] 27984\n'));
						cmd.stdout.on('data', async (data) => {
							const tests: UnitTest[] = [];
							const data_ = data.toString();
							buffer += data;
							if (buffer.includes('###')) {

								if (buffer.includes('Executing test')) {
									const info: string[] = buffer.match(/Executing test\s(.*)...\nDEBUG\s[(](.*)[)].*\n(.*)/g);
									info.forEach(element => {
										if (element.trim().startsWith('Executing test')) {
											const unitTestInfo = element.match(/Executing test\s(.*)...\nDEBUG\s[(](.*)[)]:\s(.*)\n(.*)/);


											if (unitTestInfo) {
												const unitTest = {
													name: unitTestInfo[1],
													result: unitTestInfo[4],
													time: unitTestInfo[2],
													assert: unitTestInfo[3]
												} as UnitTest;
												tests.push(unitTest);
											}

										}
									});

									//search for additional unit test info
									glob(projectPath + '/source/**/*.mc', {}, (err, files) => {

										files.forEach(async element => {

											const fileStream = createReadStream(element);

											const rl = readline.createInterface({
												input: fileStream,
												crlfDelay: Infinity
											});

											let lineCount = 0;
											for await (const line of rl) {
												lineCount++;
												tests.forEach(unitTest => {
													const unitTestName = unitTest.name.split('.');
													let nameWithoutClass = "";

													if (unitTestName.length > 1) {
														nameWithoutClass = unitTestName[1];
													}
													else {
														nameWithoutClass = unitTestName[0];
													}
													if (line.includes(nameWithoutClass)) {
														const additionalInfoObj = {
															additionalInfo: {
																name: unitTest.name,
																file: rl.input.path,
																line: lineCount
															}

														};
														vscode.commands.executeCommand('extension.mock-debug.sendMessageToWebView', additionalInfoObj);
													}
												});

											}

										});
										console.log(files);
									});

									vscode.commands.executeCommand('extension.mock-debug.sendMessageToWebView', tests);
									//console.log(data_);
									cmd.kill();
									buffer = '';
								}
								else {
									console.log('No unit tests found.');
								}
							}




						});



					}
				},
				undefined,
				context.subscriptions
			);
			currentPanel.onDidDispose(
				() => {
					currentPanel = undefined;
				},
				undefined,
				context.subscriptions
			);
		})
	);
}
function getWebviewContent() {
	return `<!DOCTYPE html>
  <html lang="en">
  <head>
	  <meta charset="UTF-8">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Cat Coding</title>
  </head>
  <body>
	  <h1>SDK path</h1>
	  <input type="text" id="sdkPath" name="sdkPath">
	  <h1>Project path</h1>
	  <input type="text" id="projectPath" name="projectPath">
	  <br>
	  <input style="display:block" type="submit" id="saveBttn" value="Save">
	  <script>
		  (function() {
			  const vscode = acquireVsCodeApi();
			  const counter = document.getElementById('sdkPath');
			  document.getElementById('saveBttn').addEventListener('click',()=>{
				vscode.postMessage({
					command: 'alert',
					text: document.getElementById('sdkPath').value+" "+document.getElementById('projectPath').value
				})
			  });
			  let count = 0;
			  
			 
		  }())
	  </script>
  </body>
  </html>`;
}
function getUnitTestsWebviewContent() {
	return `<!DOCTYPE html>
  <html lang="en">
  <head>
	  <meta charset="UTF-8">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Cat Coding</title>
  </head>
  <body>
	  
	  <input type="button" id="runTestsBttn" name="runTestsBttn" value="Run unit tests">
	  
	  <br>
	  <br>
	  
	  <table id="unitTests" style="width:100%">
	  <thead>
	  <tr>
	  <th>Name</th>
	  <th>Result</th>
	  <th>Assert</th>
	  <th>Time of execution</th>
	  <th>Location</th>
	  <th></th>
	</tr>
  </thead>
  <tbody>
  
  </tbody>
</table>
	  <script>
			  const vscode = acquireVsCodeApi();
			  document.getElementById('runTestsBttn').addEventListener('click',()=>{
				vscode.postMessage({
					command: 'run-tests',
					text: 'run tests'
				})
			  });
			  
			  document.addEventListener('click',function(e){
				if(e.target && e.target.className==='runAgain'){
					
					  vscode.postMessage({
									command: 'run-test-again',
									text: e.target.id.split('-')[0]
								})
				 }
			 });

				 
			  
		  
		  window.addEventListener('message', event => {
			const div=document.getElementById('unitTests').getElementsByTagName('tbody')[0];
            const message = event.data; // The JSON data our extension sent
			const data=JSON.parse(message);
			if (data.additionalInfo!== undefined){
				document.getElementById(data.additionalInfo.name).getElementsByClassName('Location')[0].innerHTML=data.additionalInfo.file+':'+data.additionalInfo.line.toString();
			}
			data.forEach((x)=>{
				const tableRow=document.getElementById(x.name);
				if (tableRow!==undefined && tableRow!==null){
					tableRow.innerHTML='<td style="text-align: center;">'+x.name+'</td> <td style="text-align: center;">'+x.result+'</td><td style="text-align: center;">'+x.assert+'</td> <td style="text-align: center;">'+x.time+'</td><td class="Location" style="text-align: center;"></td> <td style="text-align: center;"><input type="button" class="runAgain" id='+x.name+'-RunAgainBttn name="runAgain" value="Run again"></td>';
				}
				else{
					div.innerHTML+='<tr id='+x.name+'><td style="text-align: center;">'+x.name+'</td> <td style="text-align: center;">'+x.result+'</td><td style="text-align: center;">'+x.assert+'</td> <td style="text-align: center;">'+x.time+'</td><td class="Location" style="text-align: center;"></td> <td style="text-align: center;"><input type="button" class="runAgain" id='+x.name+'-RunAgainBttn name="runAgain" value="Run again"></td></tr>';
				}	
						
					
				
				
				
			});
            
        });
	  </script>
  </body>
  </html>`;
}


export function deactivate() {
	// nothing to do
}

class MockConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'markdown' || editor.document.languageId === 'monkeyc')) {
				config.type = 'mock';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.workspaceFolder = '${workspaceFolder}';
				config.stopOnEntry = true;
				config.test = '${command:extension.mock-debug.config}';
			}
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
	// resolveDebugConfigurationWithSubstitutedVariables(folder: WorkspaceFolder, debugConfiguration: DebugConfiguration, token: CancellationToken): ProviderResult<DebugConfiguration> {
	// 	return null;
	// }
}

class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {

	// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
	// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.

	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
		// param "executable" contains the executable optionally specified in the package.json (if any)

		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
		if (!executable) {
			const command = "./out/debugAdapter.js";
			const args = [
				"some args",
				"another arg"
			];
			const options = {
				cwd: "working directory for executable",
				env: { "envVariable": "some value" }
			};
			executable = new vscode.DebugAdapterExecutable(command, args, options);
		}

		// make VS Code launch the DA executable
		return executable;
	}
}

class MockDebugAdapterServerDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new MockDebugSession();
				session.setRunAsServer(true);
				session.start(socket as NodeJS.ReadableStream, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((this.server.address() as Net.AddressInfo).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

class MockDebugAdapterNamedPipeServerDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random named pipe path
			const pipeName = randomBytes(10).toString('utf8');
			const pipePath = platform === "win32" ? join('\\\\.\\pipe\\', pipeName) : join(tmpdir(), pipeName);

			this.server = Net.createServer(socket => {
				const session = new MockDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(pipePath);
		}

		// make VS Code connect to debug server
		// TODO: enable named pipe support as soon as VS Code 1.49 is out
		//return new vscode.DebugAdapterNamedPipeServer(this.server.address() as string);
		return undefined;
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new MockDebugSession());
	}
}
