/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { DebuggerListener } from './debuggerListener';
import { glob } from 'glob';
import * as path from 'path';

export interface IMockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IStepInTargets {
	id: number;
	label: string;

}
export interface IMockVariable {
	name: string;
	value?: string;
	type?: string;
	variablesReference: number;
	children: IMockVariable[];
}

interface IStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
}

interface IStack {
	count: number;
	frames: IStackFrame[];
}

interface IError {
	id: string;
	description: string;
	details: IErrorDetails;
}
interface IErrorDetails {
	message: string;
	typeName?: string;
	stackTrace: string;
}

export class MockRuntime extends EventEmitter {
	private _currentProjectFolder;

	private _sdkPath;

	private _sourceFiles = new Map<string, string[]>();
	public get sourceFiles() {
		return this._sourceFiles;
	}
	private _currentFile;

	private _sourceLines: string[] = [];

	private _device;

	private _currentLine = 0;

	private _currentColumn: number | undefined;

	private _localVariables: IMockVariable[] = [];
	public get localVariables() {
		return this._localVariables;
	}

	private _argsVariables: IMockVariable[] = [];
	public get argsVariables() {
		return this._argsVariables;
	}

	private _globalVariables: IMockVariable[] = [];
	public get globalVariables() {
		return this._globalVariables;
	}

	private _breakPoints = new Map<string, IMockBreakpoint[]>();

	private _buffer;

	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private debuggerListener = new DebuggerListener();

	private _noDebug = false;

	private _isStarted = false;

	private _debuggerStarted = false;

	private _messageSender;

	private _errorLog;

	private _isRunning;

	private _timer: NodeJS.Timeout | null = null;

	constructor() {
		super();
	}

	public setCurrentWorkspaceFolder(path: string) {
		this._currentProjectFolder = path;
	}
	/**
	 * Start executing the given program.
	 */
	public async start(program: string, sdkPath: string, workspaceFolder: string, stopOnEntry: boolean, noDebug: boolean, device: string, launchDone, configurationDone) {

		this._device = device;

		this._noDebug = noDebug;

		this.loadSource(program);

		this._currentProjectFolder = workspaceFolder;
		this._sdkPath = sdkPath;
		const files = glob.sync(this._currentProjectFolder + '/**/*.mc');
		files.forEach(element => {
			const path_ = path.normalize(element).charAt(0).toLowerCase() + path.normalize(element).slice(1);
			if (!this.sourceFiles.get(path_)) {
				this._sourceFiles.set(path_, []);
			}

		});

		await this.launchDebugger();
		launchDone.notifyAll();

		this._currentLine = -1;
		if (configurationDone.notified === false) {
			await configurationDone.wait();
		}

		this.continue();

		if (stopOnEntry) {
			// we step once
			this.step(false, 'stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception

		}
		return null;
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue(reverse = false) {

		this.clearVariables();

		if (!this._isStarted) {
			this._messageSender.stdin.write(Buffer.from('run \n'));
			this._isStarted = true;
		}
		else {
			this._messageSender.stdin.write(Buffer.from('continue\n'));
			console.log('continuing');

		}

		let output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "runInfo");

			//dont wait if program doesnt stop at breakpoint
			setTimeout(resolve, 5000);
		});



		const info = output?.match(/Hit breakpoint ([0-9]+)(?:.|\n|\r)*at (.*):([0-9]+)/);
		if (info) {
			this._currentFile = this.getFileFullPath(info[2]);
			this.run(reverse, Number(info[3]) - 1, undefined);
		}
		else {
			if (!this._errorLog) {
				this._isRunning = true;
				this.sendEvent('continued');
				this.sendEvent('executeProgram');
			}

		}

	}

	public continueFn() {
		if (this._timer) {
			clearTimeout(this._timer);
		}
		this._timer = setTimeout(async () => {
			this._timer = null;
			await this.continue();
			this.sendEvent('continuedAfterSetBreakpointsRequest');
		}, 5000);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public async step(reverse = false, event = 'stopOnStep') {

		this.clearVariables();

		this._messageSender.stdin.write(Buffer.from('next \n'));

		this._messageSender.stdin.write(Buffer.from('frame \n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "nextInfo");

		});

		const nextInfo = output.match(/#([0-9]+)\s+(.*)\s.*at (.*):([0-9]+)/);
		if (nextInfo) {

			this._currentFile = this.getFileFullPath(nextInfo[3]);
			this.run(reverse, Number(nextInfo[4]) - 1, event);
		}

	}

	/**
	 * "Step into" for Mock debug means: go to next character
	 */
	public async stepIn(targetId: number | undefined, event = 'stopOnStep') {

		this.clearVariables();

		this._messageSender.stdin.write(Buffer.from('step\r\n'));
		this._messageSender.stdin.write(Buffer.from('frame\r\n'));
		const output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "nextInfo");

		});
		const nextInfo = output.match(/#([0-9]+)\s+(.*)\s.*at (.*):([0-9]+)/);
		if (nextInfo) {
			const file = this.getFileFullPath(nextInfo[3]);
			this.loadSource(file);
			this._currentFile = file;
			this.run(false, Number(nextInfo[4]) - 1, event);
		}

	}

	/**
	 * "Step out" for Mock debug means: go to previous character
	 */
	public stepOut() {

		this.clearVariables();

		if (typeof this._currentColumn === 'number') {
			this._currentColumn -= 1;
			if (this._currentColumn === 0) {
				this._currentColumn = undefined;
			}
		}
		this.sendEvent('stopOnStep');
	}

	public getStepInTargets(frameId: number): IStepInTargets[] {

		const line = this._sourceLines[this._currentLine].trim();

		// every word of the current line becomes a stack frame.
		const words = line.split(/\s+/);

		// return nothing if frameId is out of range
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		// pick the frame for the given frameId
		const frame = words[frameId];

		const pos = line.indexOf(frame);

		// make every character of the frame a potential "step in" target
		return frame.split('').map((c, ix) => {
			return {
				id: pos + ix,
				label: `target: ${c}`
			};
		});
	}


	public async getLocalVariables(variableHandles): Promise<IMockVariable[]> {
		if (this._localVariables.length > 0) {
			return this._localVariables;
		}
		this._localVariables = [];
		this._messageSender.stdin.write(Buffer.from('info frame\n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "variablesInfo");

		});

		if (output && !output.includes("No app is suspended.") && !output.includes('No locals.')) {

			const parsedOutput = output.match(/Locals:(.*)/s);
			if (parsedOutput) {
				const lines = parsedOutput[1].split('\r\n');
				await Promise.all(lines.map(async (line) => {
					if (line !== "") {

						const variableInfo = line.trim().match(/(.*) = (.*)/);
						if (variableInfo) {
							if (variableInfo[2] === 'null') {
								this._localVariables.push({ name: variableInfo[1], value: variableInfo[2], type: 'undefined', variablesReference: 0, children: [] });
							}
							else {

								this._messageSender.stdin.write(Buffer.from('print ' + variableInfo[1] + ' \n'));
								const output: string = await new Promise((resolve) => {
									this.debuggerListener.waitForData(resolve, 'childVariablesInfo_' + variableInfo[1]);

								});

								//check for nested structure
								if (output.split('\n').length > 1 && !variableInfo[2].split(' ')[1].includes('Lang.String')) {
									let indentation = 2;

									if (variableInfo[2].split(' ')[1].includes('Lang.Array') || variableInfo[2].split(' ')[1].includes('Lang.Dictionary')) {
										indentation = 4;
										this.index = 2;
									}

									const variable: IMockVariable = { name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), children: [], variablesReference: variableHandles.create(variableInfo[1]) };
									this.parseChildVariables(output.split('\n'), indentation, variable.children, variableHandles);
									this._localVariables.push(variable);
									this.index = 0;
								}
								else {
									this._localVariables.push({ name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), variablesReference: 0, children: [] });
								}

							}
						}
					}

				}));

				return this._localVariables;
			}

		}

		return [];
	}

	public async getArgsVariables(variableHandles): Promise<IMockVariable[]> {
		if (this._argsVariables.length > 0) {
			return this._argsVariables;
		}
		this._messageSender.stdin.write(Buffer.from('info frame\n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "variablesInfo");

		});

		if (output && !output.includes("No app is suspended.")) {

			const parsedOutput = output.match(/Args:(.*) (Locals:|No locals\.)/s);
			if (parsedOutput) {
				const lines = parsedOutput[1].split('\r\n');
				await Promise.all(lines.map(async (line) => {
					if (line !== "") {

						const variableInfo = line.trim().match(/(.*) = (.*)/);
						if (variableInfo) {
							if (variableInfo[2] === 'null') {
								this._argsVariables.push({ name: variableInfo[1], value: variableInfo[2], type: 'undefined', variablesReference: 0, children: [] });
							}
							else {

								this._messageSender.stdin.write(Buffer.from('print ' + variableInfo[1] + ' \n'));
								const output: string = await new Promise((resolve) => {
									this.debuggerListener.waitForData(resolve, 'childVariablesInfo_' + variableInfo[1]);

								});

								//check for nested structure
								if (output.split('\n').length > 1 && !variableInfo[2].split(' ')[1].includes('Lang.String')) {
									let indentation = 2;

									if (variableInfo[2].split(' ')[1].includes('Lang.Array') || variableInfo[2].split(' ')[1].includes('Lang.Dictionary')) {
										indentation = 4;
										this.index = 2;
									}

									const variable: IMockVariable = { name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), children: [], variablesReference: variableHandles.create(variableInfo[1]) };
									this.parseChildVariables(output.split('\n'), indentation, variable.children, variableHandles);
									this._argsVariables.push(variable);
									this.index = 0;
								}
								else {
									this._argsVariables.push({ name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), variablesReference: 0, children: [] });
								}

							}
						}
					}

				}));
				return this._argsVariables;

			}

		}

		return [];
	}

	public async getGlobalVariables(variableHandles) {
		if (this._globalVariables.length > 0) {
			return this._globalVariables;
		}
		this._messageSender.stdin.write(Buffer.from('help support\n'));
		this._messageSender.stdin.write(Buffer.from('info variables\n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "globalVariablesInfo");

		});

		if (output && !output.includes("No app is suspended.")) {

			const lines = output.split('\r\n');
			await Promise.all(lines.map(async (line) => {
				if (line !== "") {

					const variableInfo = line.trim().match(/(.*) = (.*)/);
					if (variableInfo) {
						if (variableInfo[2] === 'null') {
							this._globalVariables.push({ name: variableInfo[1], value: variableInfo[2], type: 'undefined', variablesReference: 0, children: [] });
						}
						else {

							this._messageSender.stdin.write(Buffer.from('print ' + variableInfo[1] + ' \n'));
							const output: string = await new Promise((resolve) => {
								this.debuggerListener.waitForData(resolve, 'childVariablesInfo_' + variableInfo[1]);

							});


							//check for nested structure
							if (output.split('\n').length > 1 && !variableInfo[2].split(' ')[1].includes('Lang.String')) {
								let indentation = 2;

								if (variableInfo[2].split(' ')[1].includes('Lang.Array') || variableInfo[2].split(' ')[1].includes('Lang.Dictionary')) {
									indentation = 4;
									this.index = 2;
								}

								const variable: IMockVariable = { name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), children: [], variablesReference: variableHandles.create(variableInfo[1]) };
								this.parseChildVariables(output.split('\n'), indentation, variable.children, variableHandles);
								this._globalVariables.push(variable);
								this.index = 0;
							}
							else {
								this._globalVariables.push({ name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), variablesReference: 0, children: [] });
							}

						}
					}
				}

			}));

			return this._globalVariables;

		}

		return [];
	}

	private index = 0;

	private _isKeyValuePair = false;

	private parseChildVariables(lines: string[], indentation, variables: IMockVariable[], variableHandles) {

		//only for testing

		this.index++;

		if (this.index < lines.length) {

			//skip array parentheses
			if (/^\[$/.test(lines[this.index].trim()) || /^\][,]$/.test(lines[this.index].trim()) || /^\]$/.test(lines[this.index].trim()) || /^[,]$/.test(lines[this.index].trim()) || lines[this.index].trim().length === 1 || /^\{$/.test(lines[this.index].trim()) || /^\}[,]$/.test(lines[this.index].trim()) || /^\}$/.test(lines[this.index].trim())) {
				this.index++;
			}
			if (this.index >= lines.length) {
				return;
			}
			if (lines[this.index].trim() === '=>') {
				this._isKeyValuePair = true;
				this.index++;
			}
			//handle dictionary entries


			let currentIndentation;

			const varInfo = lines[this.index].trim().split(' ');

			//get indentation

			currentIndentation = lines[this.index].match(/(\s+).*/)![1].length;


			if (currentIndentation === indentation) {


				//structured object
				if (/^.+\s[=]$/.test(lines[this.index].trim()) || /[<].+[>]/.test(varInfo[0])) {
					let variable: IMockVariable;
					let indentation: number = 0;
					let varTypeAndReference;
					//var name case

					if (!/[<].+[>]/.test(varInfo[0])) {
						variable = { name: varInfo[0], children: [], variablesReference: 0 };
						this.index++;
						varTypeAndReference = lines[this.index].trim().split(' ');
						variable.type = varTypeAndReference[1].replace(/[/)]|[/(]/g, '');
					}

					//var in dict
					else {
						varTypeAndReference = lines[this.index].trim().split(' ');
						variable = { name: 'dict_entry', type: varInfo[1].replace(/[/)]|[/(]/g, ''), children: [], variablesReference: 0 };
					}

					//handle string var
					switch (variable.type) {
						case 'Lang.String':
							variable.name = variable.name.replace(/[[]|\]/g, '');
							this.index += 2;
							variable.value = lines[this.index].trim().replace(/[,]/g, '');
							variables.push(variable);

							break;
						case 'Lang.Array':
							variable.name = variable.name.replace(/[[]|\]/g, '');
							variable.value = varTypeAndReference[0];
							variable.variablesReference = variableHandles.create(varTypeAndReference[0]);
							this.index += 2;


							//next indentation level
							indentation = lines[this.index + 1].match(/(\s+).*/)![1].length;
							break;


						case 'Lang.Dictionary':
							variable.variablesReference = variableHandles.create(varTypeAndReference[0]);
							variable.value = varTypeAndReference[0];

							this.index += 2;
							indentation = lines[this.index + 1].match(/(\s+).*/)![1].length;

							break;
						default:
							variable.name = variable.name.replace(/[[]|\]/g, '');
							variable.value = varTypeAndReference[0];
							variable.variablesReference = variableHandles.create(varTypeAndReference[0]);

							//next indentation level
							indentation = lines[this.index + 1].match(/(\s+).*/)![1].length;

							break;


					}

					if (variable.type !== 'Lang.String') {
						this.parseChildVariables(lines, indentation, variable.children, variableHandles);
						variables.push(variable);
						this.index--;
					}

					if (this._isKeyValuePair && variables.filter(x => x.name === 'dict_entry').length === 2) {
						const key = variables[variables.length - 2];
						key.name = 'key';

						const value = variables[variables.length - 1];
						value.name = 'value';

						const keyValuePair: IMockVariable = { name: key.value!, value: value.value, children: [key, value], variablesReference: 0 };
						keyValuePair.variablesReference = variableHandles.create(keyValuePair.value);

						variables.splice(variables.length - 2, 2);

						variables.push(keyValuePair);

						this._isKeyValuePair = false;
					}


					this.parseChildVariables(lines, currentIndentation, variables, variableHandles);
				}
				else {

					//handle dictionary entry
					if (varInfo.length === 2) {
						variables.push({ name: 'dict_entry', value: varInfo[0], type: varInfo[1].replace(/[/)]|[/(]/g, ''), children: [], variablesReference: 0 });

						if (this._isKeyValuePair && variables.filter(x => x.name === 'dict_entry').length === 2) {
							const key = variables[variables.length - 2];
							key.name = 'key';

							const value = variables[variables.length - 1];
							value.name = 'value';

							const keyValuePair: IMockVariable = { name: key.value!, value: value.value, children: [key, value], variablesReference: 0 };
							keyValuePair.variablesReference = variableHandles.create(keyValuePair.value);

							variables.splice(variables.length - 2, 2);

							variables.push(keyValuePair);

							this._isKeyValuePair = false;
						}
					}
					else {
						if (/^null,?$/.test(varInfo[2])) {
							variables.push({ name: /[[][0-9]+]/.test(varInfo[0]) ? varInfo[0].replace(/[[]|\]/g, '') : varInfo[0], value: varInfo[2]?.replace(/[,]/g, ''), type: 'undefined', variablesReference: 0, children: [] });
						}
						else {
							variables.push({ name: /[[][0-9]+]/.test(varInfo[0]) ? varInfo[0].replace(/[[]|\]/g, '') : varInfo[0], value: varInfo[2], type: varInfo[3]?.replace(/([/)]|[/(])|[,]/g, ''), variablesReference: 0, children: [] });
						}

					}
					this.parseChildVariables(lines, currentIndentation, variables, variableHandles);
				}
			}

		}

	}
	private childrenVariables: IMockVariable[] = [];

	public getChildVariables(variablesReference, index, variables: IMockVariable[]): IMockVariable[] {

		if (index < variables.length) {
			const currentVariable = variables[index];
			if (currentVariable.variablesReference === variablesReference) {
				this.childrenVariables = currentVariable.children;
			} else if (currentVariable.children.length > 0) {
				this.getChildVariables(variablesReference, 0, currentVariable.children);
			}
			index++;
			this.getChildVariables(variablesReference, index, variables);
		}
		return this.childrenVariables;
	}

	private result: IMockVariable | null = null;

	private clearVariables() {
		this._globalVariables = [];
		this._localVariables = [];
		this._argsVariables = [];
	}

	public evaluate(expression, index, variables: IMockVariable[]): IMockVariable | null {
		if (index < variables.length) {
			const currentVariable = variables[index];
			if (currentVariable.name === expression) {
				this.result = currentVariable;
			} else if (currentVariable.children.length > 0) {
				this.evaluate(expression, 0, currentVariable.children);
			}
			index++;
			this.evaluate(expression, index, variables);
		}

		return this.result;
	}
	public clearVariable() {
		this.result = null;
	}

	public async stack() {
		const frames = new Array<IStackFrame>();
		if (this._errorLog) {
			if (!/ERROR:.+/.test(this._errorLog)) {
				const stackInfo = this._errorLog.match(/.+Stack:(.*)Encountered app crash./s)[1].trim().split(' ');
				const stackFrame: IStackFrame = {
					index: 1,
					name: stackInfo[1],
					file: stackInfo[3].match(/(.+mc).+/)[1],
					line: Number(stackInfo[3].match(/.+mc:([0-9]+)/)[1])
				};
				frames.push(stackFrame);
				return {
					frames: frames,
					count: 1
				};
			}
			return undefined;
		}
		else {
			this._messageSender.stdin.write('backtrace \n');

			let frameInfo: string = await new Promise((resolve) => {
				this.debuggerListener.waitForData(resolve, "frameInfo");


			});
			const frameInfoLines = frameInfo.split('\n');
			if (frameInfo) {
				let _frameInfo;
				let stackFrame;
				frameInfoLines.forEach((line) => {

					if (/#([0-9]+)\s+(.+) in (.*) at (.+):([0-9]+)/.test(line)) {
						_frameInfo = line.match(/#([0-9]+)\s+(.+) in (.*) at (.+):([0-9]+)/);
						stackFrame = {
							index: Number(_frameInfo[1]),
							name: _frameInfo[3],
							file: this.getFileFullPath(_frameInfo[4]),
							line: Number(_frameInfo[5])
						} as IStackFrame;
					}
					else {
						_frameInfo = line.match(/#([0-9]+)\s+(.+) at (.+):([0-9]+)/);
						stackFrame = {
							index: Number(_frameInfo[1]),
							name: _frameInfo[2],
							file: this.getFileFullPath(_frameInfo[3]),
							line: Number(_frameInfo[4])
						} as IStackFrame;
					}
					frames.push(stackFrame);
				});
				return {
					frames: frames,
					count: 1
				};
			}
			else {
				return {
					frames: [],
					count: 0
				};
			}
		}

	}

	public getBreakpoints(path: string, line: number): number[] {

		const l = this._sourceLines[line];

		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			} else {
				sawSpace = true;
			}
		}

		return bps;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number) {
		const bp: IMockBreakpoint = { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<IMockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		await this.addBreakPointDebugger(bp.line, path);

		this.verifyBreakpoints(path);

		return bp;
	}

	public checkIfBreakPointDeleted(breakpoints: number[] | undefined, path: string) {
		const bps = this._breakPoints.get(path);
		if (bps) {
			if (breakpoints) {
				if (bps.length > breakpoints.length) {
					bps.forEach((bp) => {
						let bpFind = breakpoints.find(line => line === bp.line);
						if (!bpFind) {
							//this.clearBreakPointDebugger(bp.line, path);
						}
					});
				}
			}
		}


	}
	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): IMockBreakpoint | undefined {
		const bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	public parseErrorInfo() {
		if (this._errorLog) {

			//app crash
			if (!/ERROR:.+/.test(this._errorLog)) {


				const error: IError = {
					id: '1',
					description: this._errorLog.match(/.+Error:(.+)\nDetails.+/s)[1].trim(),
					details: {
						message: this._errorLog.match(/.+Details:(.+)\nStack.+/s)[1].trim(),
						stackTrace: this._errorLog.match(/.+Stack: \n  -(.+)\n\nEncountered app crash.+/s)[1].trim()
					}
				};
				return error;
			}

		}
		return undefined;
	}
	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {

		this.clearBreakPointsDebugger(path);
		this._breakPoints.delete(path);

	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	// private methods

	private loadSource(file: string) {

		if (!this._sourceFiles.get(file)) {

			const lines: string[] = readFileSync(file).toString().split('\n');
			this._sourceFiles.set(file, lines);

		}
		else if (this._sourceFiles.get(file) && this._sourceFiles.get(file)?.length === 0) {
			const lines: string[] = readFileSync(file).toString().split('\n');
			this._sourceFiles.set(file, lines);
		}
	}


	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, lineStop: Number, stepEvent?: string) {

		const lines = this._sourceFiles.get(this._currentFile);

		if (lines) {
			for (let ln = -1; ln < lines?.length; ln++) {
				if (this.fireEventsForLine(ln, lineStop, stepEvent)) {
					this._currentLine = ln;
					this._currentColumn = undefined;
					return true;
				}
			}
			// no more lines: run to end
			this.sendEvent('end');
		}


	}

	private verifyBreakpoints(path: string) {

		if (this._noDebug) {
			return;
		}

		const bps = this._breakPoints.get(path);
		if (bps) {
			this.loadSource(path);
			bps.forEach(bp => {
				bp.verified = true;
				this.sendEvent('breakpointValidated', bp);

			});
		}
	}

	/**
	 * Fire events if line has a breakpoint
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, lineStop: Number, stepEvent?: string): boolean {

		if (this._noDebug) {
			return false;
		}

		//is there a breakpoint?
		const breakpoints = this._breakPoints.get(this._currentFile);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				//skip breakpoint if not verified
				if (!bps[0].verified) {
					return false;
				}
				// send 'stopped' event
				if (lineStop === bps[0].line) {
					this.sendEvent('stopOnBreakpoint');
					return true;
				}

			}
		}

		// non-empty line
		if (stepEvent) {
			this.sendEvent(stepEvent);
			return true;
		}

		return false;
	}
	private clearBreakPointsDebugger(path: string) {
		const bpsToBeCleared = this._breakPoints.get(path);
		if (bpsToBeCleared) {

			const last = bpsToBeCleared[bpsToBeCleared?.length - 1];
			if (bpsToBeCleared.length === 1) {
				const clearBreakpointsCommand = 'delete ' + last.id + '\n';
				this._messageSender.stdin.write(clearBreakpointsCommand);
			}
			else {
				const clearBreakpointsCommand = 'delete ' + bpsToBeCleared[0].id + '-' + last.id + '\n';
				this._messageSender.stdin.write(clearBreakpointsCommand);
			}

		}

	}
	public getFileFullPath(file: string): string {
		let fullPath;
		for (let key of this._sourceFiles.keys()) {
			if (key.endsWith(file)) {
				fullPath = key;
			}
		}
		return fullPath;
	}

	private async addBreakPointDebugger(ln: number, path: string) {
		if (this._isRunning) {
			this._messageSender.stdin.write(Buffer.from('a\r\n'));
			await new Promise(resolve => setTimeout(resolve, 5000));
		}

		let setBreakpointCommand = 'break ' + path + ':' + (ln + 1).toString() + '\n';
		this._messageSender.stdin.write(setBreakpointCommand);
		console.log(setBreakpointCommand);

	}

	public killChildProcess() {
		this._messageSender.kill();
	}

	public async launchDebugger() {
		//start messageSender process
		this._messageSender = spawn('cmd', ['/K'], { shell: true });
		this._messageSender.stdin.setEncoding = 'utf-8';
		this._messageSender.stdout.setEncoding = 'utf-8';
		this._messageSender.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
		this._messageSender.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));

		const projectName = this._currentProjectFolder.match(/.*\\(.*)/)[1];
		const compileCmmd = 'monkeyc -d ' + this._device + ' -f "' + this._currentProjectFolder + '\\monkey.jungle" -o "' + this._currentProjectFolder + '\\bin\\' + projectName + '.prg" -y "' + this._sdkPath + "\\developer_key.der" + '" \n';
		this._messageSender.stdin.write(Buffer.from(compileCmmd));
		this._messageSender.stdin.write(Buffer.from('connectiq\n'));

		//start the monkeyC command line debugger
		this._messageSender.stdin.write(Buffer.from('mdd\n'));

		const loadAppCmmd = 'file "' + this._currentProjectFolder + '\\bin\\' + projectName + '.prg" "' + this._currentProjectFolder + '\\bin\\' + projectName + '.prg.debug.xml" ' + this._device + ' \n';
		this._messageSender.stdin.write(Buffer.from(loadAppCmmd));

		this._messageSender.stdin.write(Buffer.from('set print max-depth 100 \n'));

		this._messageSender.stdin.write(Buffer.from('set timeout 5 \n'));

		this._messageSender.stdin.write(Buffer.from('set print array-indexes \n'));


		this._messageSender.stdout.on('data', async (data) => {

			if (data.toString().includes('Failed to launch the device: Timeout') || data.toString().includes('Failed to launch the app: Timeout')) {
				this.killSimulator('Failed to launch the device: Timeout');
			}
			if (data.toString().includes('Pausing execution')) {
				this.sendEvent('pauseProgramExecution');
			}

			//handle debugger crash
			if (data.toString().includes('Failed to get stack backtrace: Timeout')) {
				console.error('Connect IQ: Failed to get stack backtrace: Timeout');
				this.sendEvent('error', `Connect IQ: ${data.toString()}`);
			}
			if (data.toString().includes('Command failed')) {
				console.error('Connect IQ: Command failed');
				this.sendEvent('error', `Connect IQ: ${data.toString()}`);
			}



			this._buffer += data;

			//handle fatal errors

			if (/.+Error:.+Details:.+Stack:.+Encountered app crash.+/s.test(this._buffer)) {
				this._errorLog += this._buffer;
				this.sendEvent('stopOnException', this._buffer);
			}



			console.log("buffer: " + this._buffer);

			let outputLines: string[] = this._buffer.split("(mdd) ");

			outputLines = outputLines.filter((el) => { return el.length !== 0; });
			if (outputLines.length > 0) {
				let lastIndex;
				if (/(.|\n|\r)*[(]mdd[)]\s$/.test(this._buffer) || this._buffer === 'Continuing app.\r\n\r\n') {

					lastIndex = outputLines.length - 1;
				}
				else {
					if (outputLines.length !== 1) {
						lastIndex = outputLines.length - 2;
					}
					else {
						return;
					}
				}
				for (let index = 0; index <= lastIndex; index++) {

					this.debuggerListener.onData(outputLines[index].trim());
					this._buffer = this._buffer.replace(outputLines[index] + "(mdd) ", "");

				}

			}
		});
		this._messageSender.stderr.on('data', (err) => {

			if (/ERROR:.+/.test(err.toString())) {

				this._errorLog += err.toString();
				this.sendEvent('output', err.toString());
			}

		});
		this._messageSender.stdout.on('error', (err) => {
			console.log("error: " + err);

		});

		this._messageSender.on('exit', (code) => {
			console.log('child process exited with code ' + code);
		});

		await new Promise((resolve) => {
			this.debuggerListener.waitForData(resolve, "launchDebuggerInfo");


		});
		await new Promise(resolve => setTimeout(resolve, 10000));
		this._debuggerStarted = true;
		return 'launched';

	}
	private killSimulator(reason) {

		//kill simulator
		this._messageSender.stdin.write(Buffer.from('taskkill /f /t /im simulator.exe\n'));

		this.sendEvent('error', reason);
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}