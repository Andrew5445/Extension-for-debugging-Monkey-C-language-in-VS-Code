interface IWaitingFunction {
    fn: Function;
    action: string;
}


export class DebuggerMiddleware {
    private waitingFunctions: IWaitingFunction[] = [];

    private globalVariablesInfoIncoming = false;

    public onData(str: string) {
        console.log('\x1b[31m%s\x1b[0m%s', 'Received:', str);

        this.waitingFunctions.forEach(waitingFunction => {
            if (waitingFunction !== null) {
                if (waitingFunction.action !== "") {
                    switch (waitingFunction.action) {
                        case "launchDebuggerInfo":
                            if (str.includes('Loading app')) {
                                waitingFunction.fn(true);
                                this.removeWaitingFunction(waitingFunction);
                            }

                            break;
                        case "runInfo":
                            if (str.includes("Hit breakpoint")) {
                                waitingFunction.fn(str);
                                this.removeWaitingFunction(waitingFunction);
                            }

                            break;
                        case "variablesInfo":
                            if (str.includes("Locals:") || str.includes("No app is suspended.") || str.includes('No locals.')) {
                                waitingFunction.fn(str);

                                this.removeWaitingFunction(waitingFunction);
                            }

                            break;
                        case "frameInfo":
                            if (str.startsWith('#')) {
                                waitingFunction.fn(str);

                                this.removeWaitingFunction(waitingFunction);
                            }

                            break;

                        case "nextInfo":
                            if (str.startsWith('#')) {
                                waitingFunction.fn(str);
                                this.removeWaitingFunction(waitingFunction);
                            }

                            break;
                        case "globalVariablesInfo":
                            if (this.globalVariablesInfoIncoming) {
                                waitingFunction.fn(str);
                                this.removeWaitingFunction(waitingFunction);
                                this.globalVariablesInfoIncoming=false;
                            }
                    }

                    if (waitingFunction.action.startsWith('childVariablesInfo') || /No symbol ".*" in current context./.test(str)) {
                        const varName = waitingFunction.action.split('_')[1];
                        const regex = new RegExp(`^${varName}\\s[=].*$`, 's');
                        if (regex.test(str)) {
                            waitingFunction.fn(str);

                            this.removeWaitingFunction(waitingFunction);
                        }
                    }
                    if (str.startsWith('Support facilities')) {
                        this.globalVariablesInfoIncoming = true;
                    }
                }
            }
        });

    }
    public waitForData(fn, action: string) {
        this.waitingFunctions.push({ 'fn': fn, 'action': action });
    }
    public removeWaitingFunction(fn: IWaitingFunction) {
        this.waitingFunctions = this.waitingFunctions.filter(obj => obj !== fn);
    }
}