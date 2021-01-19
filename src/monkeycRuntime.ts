/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { DebuggerMiddleware } from './debuggerMiddleware';
import { glob } from 'glob';
var path = require('path');

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
	parent?: IMockVariable;
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

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime extends EventEmitter {
	private _currentWorkspaceFolder;
	private _sdkPath;
	// the initial (and one and only) file we are 'debugging'
	private _sourceFiles = new Map<string, string[]>();
	public get sourceFiles() {
		return this._sourceFiles;
	}
	private _currentFile;
	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	private _device = 'd2deltas';
	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentColumn: number | undefined;

	private _localVariables: IMockVariable[] = [];
	public get localVariables() {
		return this._localVariables;
	}

	private _globalVariables: IMockVariable[] = [];
	public get globalVariables() {
		return this._globalVariables;
	}

	//private testBuffer;
	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, IMockBreakpoint[]>();
	private buffer;
	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private debuggerMiddleware = new DebuggerMiddleware();
	private _noDebug = false;
	private isStarted = false;

	private _debuggerStarted = false;
	//private isProgramLoaded = false;
	//child process which will send commands to the monkeyC debugger
	private _messageSender;
	//private _simulator;

	//private _launchDone: boolean = false;

	constructor() {
		super();
	}


	public setCurrentWorkspaceFolder(path: string) {
		this._currentWorkspaceFolder = path;
	}
	/**
	 * Start executing the given program.
	 */
	public async start(program: string, sdkPath: string, workspaceFolder: string, stopOnEntry: boolean, noDebug: boolean, launchDone, configurationDone) {


		this._noDebug = noDebug;

		this.loadSource(program);


		this._currentWorkspaceFolder = workspaceFolder;
		this._sdkPath = sdkPath;
		const files = glob.sync(this._currentWorkspaceFolder + '/**/*.mc');
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

		//this.verifyBreakpoints(this._sourceFile);


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
		if (!this.isStarted) {
			this._messageSender.stdin.write(Buffer.from('run \n'));
			this.isStarted = true;
		}
		else {
			this._messageSender.stdin.write(Buffer.from('continue\n'));
		}

		let output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "runInfo");
			setTimeout(resolve, 2000);
		});



		const info = output.match(/Hit breakpoint ([0-9]+)(?:.|\n|\r)*at (.*):([0-9]+)/);
		if (info) {
			this._currentFile = this.getFileFullPath(info[2]);
			this.run(reverse, Number(info[3]) - 1, undefined);
		}
		else {
			this.sendEvent('continued');
		}

	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public async step(reverse = false, event = 'stopOnStep') {
		this._messageSender.stdin.write(Buffer.from('next \n'));

		//await new Promise(resolve => setTimeout(resolve, 1000));

		this._messageSender.stdin.write(Buffer.from('frame \n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "nextInfo");

		});


		const nextInfo = output.match(/#([0-9]+)\s+(.*)\s.*at (.*):([0-9]+)/);
		if (nextInfo) {

			this._currentFile = this.getFileFullPath(nextInfo[3]);
			this.run(reverse, Number(nextInfo[4]) - 1, event);
		}

	}

	// public waitForLaunchDone(resolve){
	// 	if (this._launchDone === true) { return resolve(); }
	// 	else { setTimeout(this.launchDoneNotify, 30); }
	// }
	/**
	 * "Step into" for Mock debug means: go to next character
	 */
	public async stepIn(targetId: number | undefined, event = 'stopOnStep') {
		this._messageSender.stdin.write(Buffer.from('step\r\n'));
		this._messageSender.stdin.write(Buffer.from('frame\r\n'));
		const output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "nextInfo");


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
		this._messageSender.stdin.write(Buffer.from('info frame\n'));

		const output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "variablesInfo");

		});


		if (!output.includes("Locals:") || !output.includes("No app is suspended.") || !output.includes('No locals.')) {

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
								// if (!variableInfo[2].split(' ')[1].includes('Object') && !variableInfo[2].split(' ')[1].includes('Circle') && !variableInfo[2].split(' ')[1].includes('Lang.Array')) {
								// 	this._localVariables.push({ name: variableInfo[1], value: variableInfo[2].split(' ')[0], type: variableInfo[2].split(' ')[1].replace(/[/)]|[/(]/g, ''), variablesReference: 0, children: [] });
								// }
								// else {

								this._messageSender.stdin.write(Buffer.from('print ' + variableInfo[1] + ' \n'));
								const output: string = await new Promise((resolve) => {
									this.debuggerMiddleware.waitForData(resolve, 'childVariablesInfo_' + variableInfo[1]);

								});


								//check for nested structure
								if (output.split('\n').length > 1) {
									let indentation = 2;

									if (variableInfo[2].split(' ')[1].includes('Lang.Array')) {
										indentation = 4;
										this.index = 2;
									}

									//const indentation=variableInfo[2].split(' ')[1].includes('Lang.Array')?4:2;
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

				//this._localVariables=_localVariables;

				return this._localVariables;


			}

		}

		return [];
	}

	private index = 0;


	private parseChildVariables(lines: string[], indentation, variables: IMockVariable[], variableHandles) {

		this.index++;

		if (this.index < lines.length) {

			//skip array parentheses
			if (/^\[$/.test(lines[this.index].trim()) || /^\][,]$/.test(lines[this.index].trim())) {
				this.index++;
			}

			let currentIndentation;
			const info = lines[this.index].split(' ');
			const varInfo = lines[this.index].trim().split(' ');

			//get indentation
			if (varInfo.length === 2) {

				currentIndentation = info.length - 2;
			}
			else {
				currentIndentation = info.length - 4;

			}


			if (currentIndentation === indentation) {


				//structure object
				if (varInfo.length === 2) {

					const variable: IMockVariable = { name: varInfo[0], children: [], variablesReference: 0 };
					this.index++;

					const varTypeAndMemoryAddress = lines[this.index].trim().split(' ');
					variable.type = varTypeAndMemoryAddress[1].replace(/[/)]|[/(]/g, '');

					//handle string var
					if (variable.type === 'Lang.String') {
						this.index += 2;
						variable.value = lines[this.index].trim();
					}
					else if (variable.type === 'Lang.Array') {
						variable.name = variable.name.replace(/[[]|\]/g, '');
						variable.value = varTypeAndMemoryAddress[0];
						variable.variablesReference = variableHandles.create(varTypeAndMemoryAddress[0]);
						this.index += 2;

					}
					else {
						variable.value = lines[this.index].trim().split(' ')[0];
						variable.variablesReference = variableHandles.create(varInfo[0]);
					}






					this.parseChildVariables(lines, currentIndentation + 4, variable.children, variableHandles);
					variables.push(variable);
					this.index--;
					this.parseChildVariables(lines, currentIndentation, variables, variableHandles);
				}
				else {
					if (varInfo[2] === 'null') {
						variables.push({ name: varInfo[0], value: varInfo[2], type: 'undefined', variablesReference: 0, children: [] });
					}
					else {
						variables.push({ name: /[[][0-9]+]/.test(varInfo[0]) ? varInfo[0].replace(/[[]|\]/g, '') : varInfo[0], value: varInfo[2], type: varInfo[3].replace(/([/)]|[/(])|[,]/g, ''), variablesReference: 0, children: [] });
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

	private result:IMockVariable|null=null;

	public evaluate(expression, index, variables: IMockVariable[]): IMockVariable | null {
		if (index < variables.length) {
			const currentVariable = variables[index];
			if (currentVariable.name === expression) {
				this.result=currentVariable;
				//this.childrenVariables = currentVariable.children;
			} else if (currentVariable.children.length > 0) {
				this.evaluate(expression, 0, currentVariable.children);
			}
			index++;
			this.evaluate(expression, index, variables);
		}
		return this.result;
	}




	// public async evaluateExpression(expression: string, variableHandles): Promise<IMockVariable[]> {
	// 	this._messageSender.stdin.write(Buffer.from('print ' + expression + ' \n'));
	// 	const output: string = await new Promise((resolve) => {
	// 		this.debuggerMiddleware.waitForData(resolve, 'childVariablesInfo_' + expression);


	// 	});

	// 	//handle symbol not found error
	// 	if (/No symbol ".*" in current context./.test(output)) {
	// 		return [];
	// 	}

	// 	const variables: IMockVariable[] = [];
	// 	const lines = output.split(',');
	// 	lines[0] = lines[0].replace(/.*\r/, '');
	// 	for (let index = 1; index < lines.length; index++) {

	// 		//ignore empty line
	// 		if (lines[index] !== "") {

	// 			const isStringVarInObject = lines[index].trim().split('\n').length > 1;

	// 			//handle string variable in object
	// 			if (isStringVarInObject) {
	// 				let varInfo = lines[index].trim().split(' ');
	// 				varInfo = varInfo.filter(x => x !== '');

	// 				variables.push({ name: varInfo[0], value: varInfo[7], type: varInfo[3].trim().replace(/[/)]|[/(]/g, ''), variablesReference: 0 });
	// 			}
	// 			else {
	// 				const variableInfo = lines[index].trim().split(' ');

	// 				if (variableInfo) {
	// 					if (variableInfo[2] === 'null') {
	// 						variables.push({ name: variableInfo[0], value: variableInfo[2], type: 'undefined', variablesReference: 0 });
	// 					}
	// 					else {
	// 						if (!variableInfo[3].includes('Object')) {
	// 							variables.push({ name: variableInfo[0], value: variableInfo[2], type: variableInfo[3].replace(/[/)]|[/(]/g, ''), variablesReference: 0 });
	// 						}
	// 						else {
	// 							variables.push({ name: variableInfo[0], value: variableInfo[2], type: variableInfo[3].replace(/[/)]|[/(]/g, ''), variablesReference: variableHandles.create(variableInfo[1]) });
	// 						}
	// 					}
	// 				}
	// 			}
	// 		}
	// 	}
	// 	return variables;

	// }

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public async stack(startFrame: number, endFrame: number): Promise<IStack> {
		this._messageSender.stdin.write('info frame \n');

		let frameInfo: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "frameInfo");


		});

		const info = frameInfo.match(/Stack level ([0-9]+)(?:.|\n|\r)*in (.*) at (.*):([0-9]+)/);
		if (info) {
			const frames = new Array<IStackFrame>();
			const stackFrame: IStackFrame = {
				index: Number(info[1]),
				name: info[2],
				file: this.getFileFullPath(info[3]),
				line: Number(info[4])
			};
			frames.push(stackFrame);
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
					// bps[0].verified = true;
					// this.sendEvent('breakpointValidated', bps[0]);
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
		if (this.isStarted) {
			this._messageSender.stdin.write(Buffer.from('a\r\n'));
			await new Promise(resolve => setTimeout(resolve, 5000));
		}


		let programFile = path.split("\\")[7];
		let setBreakpointCommand = 'break ' + programFile + ':' + (ln + 1).toString() + '\n';
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

		const projectName = this._currentWorkspaceFolder.match(/.*\\(.*)/)[1];
		const compileCmmd = 'monkeyc -d ' + this._device + ' -f "' + this._currentWorkspaceFolder + '\\monkey.jungle" -o "' + this._currentWorkspaceFolder + '\\bin\\' + projectName + '.prg" -y "' + this._sdkPath + "\\developer_key.der" + '" \n';
		this._messageSender.stdin.write(Buffer.from(compileCmmd));
		this._messageSender.stdin.write(Buffer.from('connectiq\n'));

		//start the monkeyC command line debugger
		this._messageSender.stdin.write(Buffer.from('mdd\n'));

		const loadAppCmmd = 'file "' + this._currentWorkspaceFolder + '\\bin\\' + projectName + '.prg" "' + this._currentWorkspaceFolder + '\\bin\\' + projectName + '.prg.debug.xml" ' + this._device + ' \n';
		this._messageSender.stdin.write(Buffer.from(loadAppCmmd));

		this._messageSender.stdin.write(Buffer.from('set print max-depth 100 \n'));

		this._messageSender.stdin.write(Buffer.from('set timeout 5 \n'));

		this._messageSender.stdin.write(Buffer.from('set print array-indexes \n'));


		this._messageSender.stdout.on('data', async (data) => {
			if (data.toString().includes('Pausing execution')) {
				this.sendEvent('stopOnPause');
			}


			//handle debugger crash
			if (data.toString().includes('Failed to get stack backtrace: Timeout')) {
				console.error('Connect IQ: Failed to get stack backtrace: Timeout');
				this.sendEvent('error', 'Connect IQ: Failed to get stack backtrace: Timeout');
			}
			this.buffer += data;
			//this.testBuffer += data;

			let outputLines: string[] = this.buffer.split("(mdd) ");


			outputLines = outputLines.filter((el) => { return el.length !== 0; });
			if (outputLines.length > 0) {
				let lastIndex;
				if (/(.|\n|\r)*[(]mdd[)]\s$/.test(this.buffer) || this.buffer === 'Continuing app.\r\n\r\n') {

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

					this.debuggerMiddleware.onData(outputLines[index].trim());
					this.buffer = this.buffer.replace(outputLines[index] + "(mdd) ", "");

				}

			}
		});
		this._messageSender.stderr.on('data', (err) => {
			console.log("error: " + err);
		});
		this._messageSender.stdout.on('error', (err) => {
			console.log("error: " + err);

		});

		this._messageSender.on('exit', (code) => {
			console.log('child process exited with code ' + code);
		});

		await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "launchDebuggerInfo");


		});
		await new Promise(resolve => setTimeout(resolve, 10000));
		this._debuggerStarted = true;
		return 'launched';

	}
	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}