/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { DebuggerMiddleware } from './debuggerMiddleware';


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
	value: string;
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


	// the initial (and one and only) file we are 'debugging'
	private _sourceFiles = new Map<string, string[]>();
	public get sourceFiles() {
		return this._sourceFiles;
	}
	private buffer;
	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentColumn: number | undefined;


	private _currentFile;
	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, IMockBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private debuggerMiddleware = new DebuggerMiddleware();
	private _noDebug = false;
	private isStarted = false;
	private isProgramLoaded = false;
	//child process which will send commands to the monkeyC debugger
	private _messageSender;
	private _simulator;

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean, noDebug: boolean) {

		this._noDebug = noDebug;

		this.loadSource(program);


		this._currentLine = -1;
		
		//this.verifyBreakpoints(this._sourceFile);

		if (stopOnEntry) {
			// we step once
			this.step(false, 'stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		}


	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue(reverse = false) {
		if (!this.isStarted) {
			this._messageSender.stdin.write(Buffer.from('r\n'));
			this.isStarted = true;
		}
		else {
			this._messageSender.stdin.write(Buffer.from('continue\n'));
		}
		let output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "runInfo");


		});
		console.log(output);
		const info = output.match(/Hit breakpoint ([0-9]+)(?:.|\n|\r)*at (.*):([0-9]+)/);
		if (info) {
			const breakpointStop: IMockBreakpoint = { id: Number(info[1]), line: Number(info[3]) - 1, verified: true };
			this.run(reverse, breakpointStop,info[2], undefined);
		}


		//run program in debugger


	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, event = 'stopOnStep') {
		this.run(reverse, null,'', event);
	}

	/**
	 * "Step into" for Mock debug means: go to next character
	 */
	public stepIn(targetId: number | undefined) {
		if (typeof targetId === 'number') {
			this._currentColumn = targetId;
			this.sendEvent('stopOnStep');
		} else {
			if (typeof this._currentColumn === 'number') {
				if (this._currentColumn <= this._sourceLines[this._currentLine].length) {
					this._currentColumn += 1;
				}
			} else {
				this._currentColumn = 1;
			}
			this.sendEvent('stopOnStep');
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

	public async getVariablesInfoFromDebugger(): Promise<IMockVariable[]> {
		this._messageSender.stdin.write(Buffer.from('info frame\n'));
		const output: string = await new Promise((resolve) => {
			this.debuggerMiddleware.waitForData(resolve, "variablesInfo");


		});


		if (!output.includes("No app is suspended.") && !output.includes("No locals.")) {
			//output.replace(/(.|\n)*Locals:/, "");
			const variables: IMockVariable[] = [];
			let parsedOutput = output.replace(/\r/g, "").replace(/(.|\n)*Locals:/, "").replace("(mdd) ", "").split("\n");
			parsedOutput.forEach((line) => {
				if (line !== "") {
					const variableInfo = line.trim().split(" = ");
					variables.push({ name: variableInfo[0], value: variableInfo[1] });
				}
			});
			return variables;




		}

		return [];

	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): IStack {
		const lines=this._sourceFiles.get(this._currentFile);
		if (lines){
			const words = lines[this._currentLine].trim().split(/\s+/);
			const frames = new Array<IStackFrame>();
		//every word of the current line becomes a stack frame.
		for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			const name = words[i];	// use a word of the line as the stackframe name
			const stackFrame: IStackFrame = {
				index: i,
				name: `${name}(${i})`,
				file: this._currentFile,
				line: this._currentLine
			};
			if (typeof this._currentColumn === 'number') {
				stackFrame.column = this._currentColumn;
			}
			frames.push(stackFrame);
		}
		return {
			frames: frames,
			count: words.length
		};







		}
		else{
			return {
				frames: [],
				count: 0
			};
		}
		//this._sourceLines[this._currentLine].trim().split(/\s+/);

		
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
	public setBreakPoint(path: string, line: number): IMockBreakpoint {
		if (!this.isProgramLoaded) {
			this.loadProgram(path);
			this.isProgramLoaded=true;
		}
		const bp: IMockBreakpoint = { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<IMockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path);

		return bp;
	}
	private loadProgram(program: string) {
		let path = program.replace(/source\\.*/, "bin");

		//start the simulator
		this._messageSender.stdin.write(Buffer.from('connectiq\n'));

		//navigate to project dir
		this._messageSender.stdin.write(Buffer.from('cd ' + path + '\n'));

		//start the monkeyC command line debugger
		this._messageSender.stdin.write(Buffer.from('mdd\n'));

		//load the program into the debugger
		let projectName = path.split("\\")[5];
		let programToBeLoadedCmmd = "file " + projectName + ".prg " + projectName + ".prg.debug.xml " + "d2deltas";
		this._messageSender.stdin.write(Buffer.from(programToBeLoadedCmmd + '\n'));

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

		//breakpoints?.forEach((num)=>console.log(num));


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
		if (!this._sourceFiles.get(file)){
			const lines:string[]=readFileSync(file).toString().split('\n');
			this._sourceFiles.set(file,lines);
		}

		// if (this._sourceFile !== file) {
		// 	this._sourceFile = file;
		// 	this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		// }
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, breakpointStop,path:string, stepEvent?: string,) {
		let fullPath;
		for (let key of this._sourceFiles.keys()) {
			if (key.endsWith(path)){
				fullPath=key;
			}
		}
		this._currentFile=fullPath;
		let lines=this._sourceFiles.get(fullPath);
		if (reverse) {
			for (let ln = this._currentLine - 1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, breakpointStop,'', stepEvent)) {
					this._currentLine = ln;
					this._currentColumn = undefined;
					return;
				}
			}
			// no more lines: stop at first line
			this._currentLine = 0;
			this._currentColumn = undefined;
			this.sendEvent('stopOnEntry');
		} else {
			if (lines){
				for (let ln = this._currentLine + 1; ln < lines?.length; ln++) {
					if (this.fireEventsForLine(ln, breakpointStop,fullPath, stepEvent)) {
						this._currentLine = ln;
						this._currentColumn = undefined;
						return true;
					}
				}
				// no more lines: run to end
				this.sendEvent('end');
			}
			
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
				//send breakpoint position to debugger
				bp.verified = true;
				this.sendEvent('breakpointValidated', bp);
				this.addBreakPointDebugger(bp.line, path);
			});
		}
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, breakpointStop: IMockBreakpoint,path:string, stepEvent?: string): boolean {

		if (this._noDebug) {
			return false;
		}

		//const line = this._sourceLines[ln].trim();

		// if 'log(...)' found in source -> send argument to debug console
		// const matches = /log\((.*)\)/.exec(line);
		// if (matches && matches.length === 2) {
		// 	this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index);
		// }

		// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
		// const words = line.split(" ");
		// for (const word of words) {
		// 	if (this._breakAddresses.has(word)) {
		// 		this.sendEvent('stopOnDataBreakpoint');
		// 		return true;
		// 	}
		// }

		// // if word 'exception' found in source -> throw exception
		// if (line.indexOf('exception') >= 0) {
		// 	this.sendEvent('stopOnException');
		// 	return true;
		// }

		//is there a breakpoint?
		const breakpoints = this._breakPoints.get(path);
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
				if (breakpointStop.id === bps[0].id && breakpointStop.line === bps[0].line) {
					this.sendEvent('stopOnBreakpoint');
					return true;
				}



		 	}
		 }

		// non-empty line
		// if (stepEvent && line.length > 0) {
		// 	this.sendEvent(stepEvent);
		// 	return true;
		// }

		// nothing interesting found -> continue
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

		// this._messageSender.stdin.write(clearBreakpointCommand);

	}
	private addBreakPointDebugger(ln: number, path: string) {
		let programFile = path.split("\\")[7];
		let setBreakpointCommand = 'break ' + programFile + ':' + (ln + 1).toString() + '\n';
		this._messageSender.stdin.write(setBreakpointCommand);
	}

	public startheDebuggerAndSimulator(): void {
		//start monkey c simulator in separate process
		this._simulator = spawn('cmd', ['/K'], { shell: true });
		this._simulator.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
		this._simulator.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));
		this._simulator.stdin.write(Buffer.from('simulator & [1] 27984\n'));


		//start messageSender process
		this._messageSender = spawn('cmd', ['/K'], { shell: true });
		this._messageSender.stdin.setEncoding = 'utf-8';
		this._messageSender.stdout.setEncoding = 'utf-8';
		this._messageSender.stdin.write(Buffer.from('for /f usebackq %i in (%APPDATA%\\Garmin\\ConnectIQ\\current-sdk.cfg) do set CIQ_HOME=%~pi\n'));
		this._messageSender.stdin.write(Buffer.from('set PATH=%PATH%;%CIQ_HOME%\\bin\n'));



		this._messageSender.stdout.on('data', async (data) => {
			//console.log('Debugger info: ' + data+"$$$");
			this.buffer += data;
			if (this.buffer.includes("mdd\n")) {

				this.buffer = this.buffer.replace(/(.|\n|\r)*mdd\n/, "");
				//console.log(this.buffer);
			}
			else {
				let outputLines: string[] = this.buffer.split("(mdd) ");
				outputLines = outputLines.filter((el) => { return el.length !== 0; });
				if (outputLines.length > 0) {
					let lastIndex;
					//var re = new RegExp(/(.|\n|\r)*(mdd)/);
					if (/(.|\n|\r)*(mdd)/.test(this.buffer)) {
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
						console.log(outputLines[index] + "\n");
						this.debuggerMiddleware.onData(outputLines[index].trim());
						this.buffer = this.buffer.replace(outputLines[index] + "(mdd) ", "");
					}

				}







			}
			this._simulator.stdout.on('data', async (data) => {
				console.log(data);
			});
			//this.debuggerMiddleware.onData(data);
		});
		this._messageSender.stderr.on('data', (err) => {
			console.log("error: " + err);


		});
		this._messageSender.on('exit', (code) => {
			// console.log('child process exited with code ' + code);
		});

	}
	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	public killMessageSenderAndSimulatorProcesses() {
		this._messageSender.stdin.write('kill \n');

		this._messageSender.kill();
		this._simulator.kill();
	}
}