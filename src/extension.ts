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
import { MonkeycDebugSession } from './monkeycDebug';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { readFile, writeFile, createReadStream, readdirSync } from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import stripJsonComments = require("strip-json-comments");

var fs = require("fs-extra");
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

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.monkeyc-debug.getSdkPath',
		() => {
			return context.globalState.get('sdkPath');
		}

	));
	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.monkeyc-debug.getProjectPath',
		() => {
			return context.globalState.get('projectPath');
		}

	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.monkeyc-debug.createProjectFromTemplate',
		async () => {

			const sdkPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getSdkPath');
			const projectPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getProjectPath');
			if (!sdkPath) {
				vscode.window.showErrorMessage('No templates found, please select sdk path in the debugger config.');
				vscode.commands.executeCommand('extension.monkeyc-debug.config');
			}
			if (!projectPath) {
				vscode.window.showErrorMessage('Project path not found.');
				vscode.commands.executeCommand('extension.monkeyc-debug.config');
			}
			else {

				const getDirectories = source =>
					readdirSync(source, { withFileTypes: true })
						.filter(dirent => dirent.isDirectory())
						.map(dirent => dirent.name);
				const projectName = await vscode.window.showInputBox({ placeHolder: 'Set Project Name' });
				const type = await vscode.window.showQuickPick(await getDirectories(`${sdkPath}\\bin\\templates`), { placeHolder: "Select a project type" });
				const templates = await getDirectories(`${sdkPath}\\bin\\templates\\${type}`);
				let template: string | undefined = "";
				if (templates.length === 1) {
					template = templates[0];
				}
				if (templates.length > 1) {
					template = await vscode.window.showQuickPick(await getDirectories(`${sdkPath}\\bin\\templates\\${type}`), { placeHolder: "Select a template" });
				}


				if (template) {
					vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Creating files",
						cancellable: true
					}, (progress, token) => {
						return new Promise(async (resolve, token) => {

							//copy template contents
							try {
								await fs.copy(`${sdkPath}\\bin\\templates\\${type}\\${template}`, projectPath);
							}
							catch (err) {
								token(err);
							}
							glob(`${projectPath}\\source\\**\\*.mc`, {}, (err, files) => {

								files.forEach(async file => {

									let content = await fs.readFile(file);
									const wordsToReplace = content.toString().match(/[$][{].+ClassName[}]/g);
									wordsToReplace.forEach(word => {
										let trimmedWord = word.match(/[$][{](.+)ClassName[}]/)[1];
										content = content.toString().replace(word, projectName + trimmedWord.charAt(0).toUpperCase() + trimmedWord.substring(1));
									});
									//content = content.replace(/[$][{](.+)ClassName[}]/, `${projectName}$1`);
									await fs.writeFile(file, content, 'utf8');
								});
								resolve("Done.");
							});

						});
					});

				}

			}
		}

	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.monkeyc-debug.showErrorMessage',
		(message) => {
			vscode.window.showErrorMessage(message);
		}

	));

	context.subscriptions.push(vscode.commands.registerCommand(
		'extension.monkeyc-debug.sendMessageToWebView',
		(data) => {
			if (!currentPanel) {
				return;
			}

			// Send a message to our webview.
			// You can send any JSON serializable data.
			currentPanel.webview.postMessage(JSON.stringify(data));
		}

	));

	context.subscriptions.push(vscode.commands.registerCommand('extension.monkeyc-debug.getProgramName', config => {
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
		vscode.commands.registerCommand('extension.monkeyc-debug.config', async () => {
			currentPanel = vscode.window.createWebviewPanel(
				'debug Config',
				'Debug Config',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);

			currentPanel.webview.html = getWebviewContent();

			//Load sdk path, project
			const sdkPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getSdkPath');
			const projectPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getProjectPath');
			if (sdkPath) {
				vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', { sdkPath });
			}
			if (projectPath) {
				vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', { projectPath });
			}

			// Handle messages from the webview
			currentPanel.webview.onDidReceiveMessage(
				message => {
					switch (message.command) {
						case 'data':
							const sdkPath = message.text.split('~')[0];
							const projectPath = message.text.split('~')[1];
							context.globalState.update('sdkPath', sdkPath);
							context.globalState.update('projectPath', projectPath);

							const launchFile: string[] = glob.sync(projectPath + '/**/.vscode/launch.json');

							//update launch.json
							readFile(launchFile[0], 'utf8', function readFileCallback(err, data) {
								if (err) {
									console.log(err);
								} else {
									let obj = JSON.parse(stripJsonComments(data));

									obj.configurations[0].sdkPath = sdkPath;
									obj.configurations[0].projectPath = projectPath;
									let json = JSON.stringify(obj); //convert it back to json
									writeFile(launchFile[0], json, 'utf8', () => { }); // write it back 
								}
							});
							vscode.commands.executeCommand('extension.monkeyc-debug.getSdkPath', message.text);
							break;
						case 'openBrowseDialog':
							vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }).then(fileUri => {
								if (fileUri) {
									vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', { path: normalizePath(fileUri[0].path), id: message.text.startsWith('sdkPath') ? 'sdkPath' : 'projectPath' });
								}


							});
							break;
					}
				},
				undefined,
				context.subscriptions
			);

		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('extension.monkeyc-debug.unitTests', () => {
			currentPanel = vscode.window.createWebviewPanel(
				'unit tests',
				'Unit tests',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);

			currentPanel.webview.html = getUnitTestsWebviewContent();

			// Handle messages from the webview
			currentPanel.webview.onDidReceiveMessage(
				async message => {
					let sdkPath:string = await vscode.commands.executeCommand('extension.monkeyc-debug.getSdkPath') as string;
					let projectPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getProjectPath') as string;
					if (!sdkPath || !projectPath) {
						if (!sdkPath) {
							vscode.window.showErrorMessage('Sdk path has not been selected.');
						}
						if (!projectPath) {
							vscode.window.showErrorMessage('Project path has not been selected.');
						}

						vscode.commands.executeCommand('extension.monkeyc-debug.config');

					}

					if (message.command === 'open-file') {
						const uri = vscode.Uri.file(message.link);
						const pos = new vscode.Position(Number(message.line), 0);
						vscode.window.showTextDocument(uri).then(editor => {
							// Line added - by having a selection at the same position twice, the cursor jumps there
							editor.selections = [new vscode.Selection(pos, pos)];

							// And the visible range jumps there too
							var range = new vscode.Range(pos, pos);
							editor.revealRange(range);
						});

					}
					if (message.command === 'run-test-again') {
						const device = await vscode.window.showQuickPick(await getAvailableDevices(projectPath), { placeHolder: "Select Garmin device" });
						const projectName = projectPath!.match(/.*\\(.*)/)![1];
						let buffer;
						const cmd = spawn('cmd', ['/K'], { shell: true });
						cmd.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
						cmd.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));
						cmd.stdin.write(Buffer.from('monkeyc -d ' + device + ' -f "' + projectPath + '\\monkey.jungle" -o "' + projectPath + '\\bin\\'+projectName+'.prg" -y "' + sdkPath + '\\developer_key.der" -t\n'));
						cmd.stdin.write(Buffer.from('connectiq\n'));
						cmd.stdin.write(Buffer.from('"' + sdkPath + '\\bin\\monkeydo.bat" "' + projectPath + '\\bin\\'+projectName+'.prg" '+device+' /t ' + message.text + '\n'));
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

										files.forEach(async file => {

											const fileStream = createReadStream(file);

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
														vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', additionalInfoObj);
													}
												});

											}

										});
										console.log(files);
									});
									vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', {tests});
									//console.log(data_);
									cmd.kill();
									buffer = '';
								}
								else {
									vscode.window.showErrorMessage('No unit tests found.');
								}
							}

						});


					}
					if (message.command === 'run-tests') {

						const device = await vscode.window.showQuickPick(await getAvailableDevices(projectPath), { placeHolder: "Select Garmin device" });
						const projectName = projectPath!.match(/.*\\(.*)/)![1];
						let buffer;
						const cmd = spawn('cmd', ['/K'], { shell: true });
						cmd.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
						cmd.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));
						cmd.stdin.write(Buffer.from('monkeyc -d ' + device + ' -f "' + projectPath + '\\monkey.jungle" -o "' + projectPath + '\\bin\\'+projectName+'.prg" -y "' + sdkPath + '\\developer_key.der" -t\n'));
						cmd.stdin.write(Buffer.from('connectiq\n'));
						cmd.stdin.write(Buffer.from('"' + sdkPath + '\\bin\\monkeydo.bat" "' + projectPath + '\\bin\\'+projectName+'.prg" '+device+' /t\n'));
						cmd.stdin.write(Buffer.from('###\n'));
						cmd.stdout.on('data', async (data) => {

							const tests: UnitTest[] = [];
							buffer += data;
							console.log(buffer);

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

													if (line.match(/.*function\s+(.+)\s*[(].*/) && line.match(/.*function\s+(.+)\s*[(].*/)[1] === nameWithoutClass) {
														const additionalInfoObj = {
															additionalInfo: {
																name: unitTest.name,
																file: rl.input.path,
																line: lineCount
															}

														};
														vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', additionalInfoObj);
													}
												});

											}

										});
									});

									vscode.commands.executeCommand('extension.monkeyc-debug.sendMessageToWebView', { tests });
									cmd.kill();
									buffer = '';
								}
								else {
									vscode.window.showErrorMessage('No unit tests found.');
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
function normalizePath(rawPath) {
	return path.normalize(rawPath.charAt(1).toLowerCase() + path.normalize(rawPath).slice(2));
}

function getWebviewContent() {
	return `<!DOCTYPE html>
  <html lang="en">
  <head>
	  <meta charset="UTF-8">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Debug Config</title>
  </head>
  <body>
  	
	  <h1 style="font-family:var(--vscode-editor-font-family);">Sdk path</h1>
	  <input style="background-color:var(--vscode-input-background);color:var(--vscode-input-foreground);border-color: var(--vscode-inputOption-activeBorder);" type="text" id="sdkPath" name="sdkPath">
	  <input style="background-color:var(--vscode-button-background);color:var(--vscode-button-foreground); margin-left:5px;border-color: var(--vscode-inputOption-activeBorder);" class="browseBttn vscode-dark" type="button" id="sdkPathBttn" name="sdkPathBttn" value="Browse">
	  <h1 style="font-family:var(--vscode-editor-font-family);">Project path</h1>
	  <input style="background-color:var(--vscode-input-background);color:var(--vscode-input-foreground);border-color: var(--vscode-inputOption-activeBorder);" type="text" id="projectPath" name="projectPath">
	  <input style="background-color:var(--vscode-button-background);color:var(--vscode-button-foreground); margin-left:5px;border-color: var(--vscode-inputOption-activeBorder);" class="browseBttn" type="button" id="projectPathBttn" name="projectPathBttn" value="Browse">
	  <br>
	  <input style="background-color:var(--vscode-button-background);color:var(--vscode-button-foreground); margin-top:20px;border-color: var(--vscode-inputOption-activeBorder);" style="display:block;margin-top:20px;" type="submit" id="saveBttn" value="Save">
	 
	  <script>
			  //const counter = document.getElementById('sdkPath');
			  const vscode = acquireVsCodeApi();
			  document.getElementById('saveBttn').addEventListener('click',()=>{
				vscode.postMessage({
					command: 'data',
					text: document.getElementById('sdkPath').value+"~"+document.getElementById('projectPath').value
				})
			  });
			  let count = 0;
			  const browseBttns=document.getElementsByClassName('browseBttn');
			  Array.from(browseBttns).forEach((el) => {
				el.addEventListener('click',()=>{
					vscode.postMessage({
						command: 'openBrowseDialog',
						text: el.id
					})
				  });
			});

			setInterval(() => {
			const previousState = vscode.getState();
			const sdk=document.getElementById('sdkPath');
			const project=document.getElementById('projectPath');

			//restore state
			if (previousState){
			if (!sdk.value || sdk.value===''){
				if (previousState.sdkPath){
					sdk.value=previousState.sdkPath;
				}
			}
			if (!project.value || project.value===''){
				if (previousState.projectPath){
					project.value=previousState.projectPath;
				}
			}
			}
			  }, 100);
			
			window.addEventListener('message', event => {
				const message = event.data;
				const data=JSON.parse(message);
				if (data){
					if (data.path){
						document.getElementById(data.id).value=data.path;
					}
					let state = vscode.getState();
					if (!state){
						state={};
					}
					//const newState={};
					if (data.sdkPath){
						const sdk=document.getElementById('sdkPath');
						sdk.value=data.sdkPath;
						
						state.sdkPath=data.sdkPath;
						console.log('added sdk path');
						console.dir(state);
					}
					if (data.projectPath){
						const project=document.getElementById('projectPath');
						project.value=data.projectPath;

						state.projectPath=data.projectPath;
						console.log('added project path');
						console.dir(state);
					}
					if (Object.keys(state).length > 0){
						vscode.setState(state);
					}
				}
				
			});
			 
		  
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
	  <title>Unit tests</title>
  </head>
  <body>
	  
	  <input style = "background-color:var(--vscode-button-background);color:var(--vscode-button-foreground);font-family:var(--vscode-editor-font-family);margin-top:10px;border-color: var(--vscode-inputOption-activeBorder);" type="button" id="runTestsBttn" name="runTestsBttn" value="Run unit tests">
	  
	  <br>
	  <br>
	  
	  <table id="unitTests" style="width:100%;border: 1px solid black;border-collapse: collapse;display:none;">
	  <thead>
	  <tr>
	  <th style="border: 1px solid black;border-collapse: collapse;">Name</th>
	  <th style="border: 1px solid black;border-collapse: collapse;">Result</th>
	  <th style="border: 1px solid black;border-collapse: collapse;">Assert</th>
	  <th style="border: 1px solid black;border-collapse: collapse;">Time of execution</th>
	  <th style="border: 1px solid black;border-collapse: collapse;">Location</th>
	  <th style="border: 1px solid black;border-collapse: collapse;"></th>
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
				});
			  });
			  
			  document.addEventListener('click',function(e){
				if(e.target && e.target.className==='runAgain'){
					
					  vscode.postMessage({
									command: 'run-test-again',
									text: e.target.id.split('-')[0]
								})
				 }
				 else if (e.target.className==='fileLink'){
					const line=e.target.closest('.Location').querySelector('.line');
					vscode.postMessage({
						command: 'open-file',
						link: e.target.innerHTML,
						line: line.innerHTML
					})
				 }
			 });

				 
			  
		  
		  window.addEventListener('message', event => {
			const div=document.getElementById('unitTests').getElementsByTagName('tbody')[0];
            const message = event.data; // The JSON data our extension sent
			const data=JSON.parse(message);
			console.log(data);
			if (data.additionalInfo!==undefined){
				document.getElementById(data.additionalInfo.name).getElementsByClassName('Location')[0].innerHTML='<a class="fileLink" style="cursor: pointer;text-decoration: underline; font-family:var(--vscode-editor-font-family);">'+data.additionalInfo.file+'</a>:'+'<span class="line">'+data.additionalInfo.line.toString()+'</span>';
			}
			if (data.tests!==undefined){
				data.tests.forEach((x)=>{
					const tableRow=document.getElementById(x.name);
					if (tableRow!==undefined && tableRow!==null){
						tableRow.innerHTML='<td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.name+'</td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.result+'</td><td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.assert+'</td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);">'+x.time+'</td><td class="Location" style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;"></td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;"><input type="button" style="font-family:var(--vscode-editor-font-family);background-color:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color: var(--vscode-inputOption-activeBorder);" class="runAgain" id='+x.name+'-RunAgainBttn name="runAgain" value="Run again"></td>';
					}
					else{
						div.innerHTML+='<tr id='+x.name+'><td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.name+'</td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.result+'</td><td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.assert+'</td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;">'+x.time+'</td><td class="Location" style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;"></td> <td style="text-align: center;font-family:var(--vscode-editor-font-family);border: 1px solid black;border-collapse: collapse;"><input type="button" style="font-family:var(--vscode-editor-font-family);background-color:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color: var(--vscode-inputOption-activeBorder);" class="runAgain" id='+x.name+'-RunAgainBttn name="runAgain" value="Run again"></td></tr>';
					}	
							
						
					
					
					
				});
				document.getElementById('unitTests').style.display='table';
			}
			
            
        });
	  </script>
  </body>
  </html>`;
}
async function getAvailableDevices(projectFolder: string) {
	let deviceList = [];
	const manifestFile = glob.sync(projectFolder + '/**/manifest.xml');
	if (manifestFile.length > 0) {
		try {
			const content = await fs.readFile(manifestFile[0]);
			try {
				const res = await parseStringPromise(content);
				const devices = res["iq:manifest"]["iq:application"][0]["iq:products"][0]["iq:product"];
				if (devices) {
					return devices.map(x => x.$.id);

				}
			} catch (err) {
				console.log(`Error occurred during parsing of manifest file contents: ${err}`);
			}

		} catch (err) {
			console.log(`Error occured during reading of manifest file: ${err}`);
		}



	}
	console.log();

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
			if (editor && editor.document.languageId === 'monkeyc') {
				config.type = 'mock';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.workspaceFolder = '${workspaceFolder}';
				config.stopOnEntry = true;
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
				const session = new MonkeycDebugSession();
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
				const session = new MonkeycDebugSession();
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
		return new vscode.DebugAdapterInlineImplementation(new MonkeycDebugSession());
	}
}