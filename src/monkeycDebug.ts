/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	// ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, ContinuedEvent, ProgressStartEvent, ProgressEndEvent
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { MonkeycRuntime, IMonkeycBreakpoint, IMonkeycVariable } from './monkeycRuntime';
import { Subject } from 'await-notify';
import * as vscode from 'vscode';
import { glob } from 'glob';
import { parseStringPromise } from 'xml2js';
import { promises as fs, promises } from 'fs';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;

	sdkPath: string;

	projectPath: string;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;

}

export class MonkeycDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)
	private _runtime: MonkeycRuntime;

	private _variableHandles = new Handles<string>();

	private _configurationDone: Subject = new Subject();

	private _launchDone: Subject = new Subject();

	private _executionPaused: Subject = null;

	private _requestSequence = 0;

	private _programExecuting = false;

	private _reportProgress = false;

	private _progressId = 10000;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MonkeycRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', MonkeycDebugSession.threadID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', MonkeycDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', MonkeycDebugSession.threadID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', MonkeycDebugSession.threadID));
		});
		this._runtime.on('stopOnException', (message) => {
			this.sendEvent(new StoppedEvent(`exception`, MonkeycDebugSession.threadID, message));
		});
		this._runtime.on('stopOnPause', () => {
			this.sendEvent(new StoppedEvent('pause', MonkeycDebugSession.threadID));
		});
		this._runtime.on('breakpointValidated', (bp: IMonkeycBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('continued', () => {
			this.sendEvent(new ContinuedEvent(1, true));
		});

		this._runtime.on('executeProgram', () => {
			const ID = '' + ++this._progressId;
			this._programExecuting = true;
			this.sendEvent(new ProgressStartEvent(ID, 'Program executing...'));
		});
		this._runtime.on('pauseProgramExecution', () => {
			this.sendEvent(new ProgressEndEvent('' + this._progressId, 'Program stopped executing.'));
		});

		this._runtime.on('continuedAfterSetBreakpointsRequest', () => {
			this._programExecuting = false;
		});
		
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});

		this._runtime.on('error', (message) => {
			this.sendEvent(new TerminatedEvent());
			vscode.window.showErrorMessage(message);
		});

		this._configurationDone.notified = false;
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */


	public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
		logger.verbose(`To client: ${JSON.stringify(command)}(${JSON.stringify(args)}), timeout: ${timeout}`);
		super.sendRequest(command, args, timeout, cb);
	}
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;

		response.body.completionTriggerCharacters = [".", "["];
		//support variable type

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		response.body.supportsRestartRequest = true;

		response.body.supportsTerminateRequest = true;
		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		response.body.supportsExceptionInfoRequest = true;

		response.body.supportsRestartRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {

		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
		this._configurationDone.notified = true;
		this._configurationDone = null;
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {


		//resolve config paths
		if (!args.projectPath) {
			args.projectPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getProjectPath') as string;

		}
		if (!args.sdkPath) {
			args.sdkPath = await vscode.commands.executeCommand('extension.monkeyc-debug.getSdkPath') as string;

		}
		if (!args.projectPath || !args.sdkPath) {
			if (!args.sdkPath) {
				vscode.window.showErrorMessage('Sdk path has not been selected.');
			}
			if (!args.projectPath) {
				vscode.window.showErrorMessage('Project path has not been selected.');
			}
			vscode.commands.executeCommand('extension.monkeyc-debug.config');
		}

		//show select device quick pick
		const device = await vscode.window.showQuickPick(await this.getAvailableDevices(args.projectPath), { placeHolder: "Select Garmin device" });
		if (device) {
			this._launchDone = await this._runtime.start(args.program, args.sdkPath, args.projectPath,!!args.noDebug, device!, this._launchDone, this._configurationDone);
			logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		}
		else {
			response.success = false;
			vscode.window.showErrorMessage('Device needs to be selected!');
		}

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

		console.log("Breakpoint request started!");

		if (this._launchDone) {
			await this._launchDone.wait();
		}

		const path = args.source.path as string;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = Promise.all(clientLines.map(async l => {
			const { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
			bp.id = id;
			return bp;
		}));

		actualBreakpoints.then((x) => {
			response.body = {
				breakpoints: x
			};
		});
		// send back the actual breakpoint positions

		console.log('sending breakpoints');
		this.sendResponse(response);


		//try continue after paused execution
		if (!this._launchDone && this._programExecuting) {
			this._runtime.continueFn();
		}

	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MonkeycDebugSession.threadID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		try {
			const stk = await this._runtime.stack();
			if (stk) {
				response.body = {
					stackFrames: stk.frames.map(f => {
						const sf = new StackFrame(f.index, f.name, this.createSource(f.file), f.line);
						if (typeof f.column === 'number') {
							sf.column = this.convertDebuggerColumnToClient(f.column);
						}
						return sf;
					}),
					totalFrames: stk.count
				};
			}
		} catch (error) {
			console.log(`Error occurred during stackTrace request ${error}`);
		}



		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Local", this._variableHandles.create("local"), true),
				new Scope("Args", this._variableHandles.create("args"), true),
				new Scope("Global", this._variableHandles.create("global"), true)
			]
		};
		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {

		const error = this._runtime.parseErrorInfo();
		if (error) {
			response.body = {
				exceptionId: error.id,
				description: error.description,
				breakMode: 'never',
				details: {
					message: error.details.message,
					typeName: 'App crash',
					stackTrace: error.details.stackTrace,
				}
			};
		}

		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];
		let actualVariables: IMonkeycVariable[] = [];

		try {
			if (this._variableHandles.get(args.variablesReference) === 'local') {

				actualVariables = await this._runtime.getLocalVariables(this._variableHandles);


			}
			else if (this._variableHandles.get(args.variablesReference) === 'args') {

				actualVariables = await this._runtime.getArgsVariables(this._variableHandles);

			}
			else if (this._variableHandles.get(args.variablesReference) === 'global') {

				actualVariables = await this._runtime.getGlobalVariables(this._variableHandles);

			}
			else {
				actualVariables = await this._runtime.getChildVariables(args.variablesReference, 0, this._runtime.localVariables.concat(this._runtime.argsVariables).concat(this._runtime.globalVariables));
			}
		} catch (error) {
			console.log(`Error occured during variables request ${error}`);

		}

		actualVariables.forEach((variable) => {
			variables.push({ name: variable.name, value: variable.value!, variablesReference: variable.variablesReference, type: variable.type });
		});

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {

		await this._runtime.continue();
		this.sendResponse(response);
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {

		super.customRequest(command, response, args);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {

		this._runtime.continue(true);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {

		this._runtime.step(true);
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {

		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {

		this._runtime.stepIn(args.targetId);
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {

		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {

		const result = this._runtime.evaluate(args.expression, 0, this._runtime.localVariables.concat(this._runtime.argsVariables).concat(this._runtime.globalVariables));
		this._runtime.clearVariable();

		if (result) {
			response.body = {
				result: result.value!,
				variablesReference: result.variablesReference
			};
		}
		if (!result) {

			response.success = false;
			response.message = `${args.expression} is not defined`;

		}

		this.sendResponse(response);
	}


	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false
		};

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["read"];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (const dbp of args.breakpoints) {
			// assume that id is the "address" to break on
			const ok = this._runtime.setDataBreakpoint(dbp.dataId);
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {

	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments) {

		this._runtime.killChildProcess();

		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}


	private async getAvailableDevices(projectFolder: string) {
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

	}
}