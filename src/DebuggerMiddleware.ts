interface IWaitingFunction {
    fn: Function;
    action: string;
}


export class DebuggerMiddleware {
    private waitingFunctions: IWaitingFunction[] = [];
    //private action:string="";


    public onData(str: string) {
        console.log('\x1b[31m%s\x1b[0m%s', 'Received:', str);

        //process.stdout.write('\x1b[31m%s\x1b[0m', 'Received:');
        //if (str.includes('Failed to get stack')
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
                            if (str.includes("Stack level")) {
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
                    }
                    // if (waitingFunction.action === "launchDebuggerInfo") {
                    //     if (str.includes('Loading app')) {
                    //         waitingFunction.fn(true);
                    //         this.removeWaitingFunction(waitingFunction);
                    //     }
                    // }
                    // if (waitingFunction.action === "runInfo") {
                    //     if (str.includes("Hit breakpoint")) {
                    //         waitingFunction.fn(str);
                    //         this.removeWaitingFunction(waitingFunction);
                    //     }
                    // }
                    // if (waitingFunction.action === "variablesInfo") {
                    //     if (str.includes("Locals:") || str.includes("No app is suspended.") || str.includes('No locals.')) {
                    //         waitingFunction.fn(str);

                    //         this.removeWaitingFunction(waitingFunction);
                    //     }

                    // }
                    // if (waitingFunction.action === "frameInfo") {
                    //     if (str.includes("Stack level")) {
                    //         waitingFunction.fn(str);

                    //         this.removeWaitingFunction(waitingFunction);
                    //     }

                    // }
                    // if (waitingFunction.action === "nextInfo") {
                    //     if (str.startsWith('#')) {
                    //         waitingFunction.fn(str);
                    //         this.removeWaitingFunction(waitingFunction);
                    //     }
                    // }
                    if (waitingFunction.action.startsWith('childVariablesInfo') || /No symbol ".*" in current context./.test(str)) {
                        const varName=waitingFunction.action.split('_')[1];
                        const regex = new RegExp(`^${varName}\\s[=].*$`,'s');
                        if (regex.test(str)) {
                            waitingFunction.fn(str);

                            this.removeWaitingFunction(waitingFunction);
                        }
                    }
                }
            }
        });



    }
    public waitForData(fn, action: string) {
        this.waitingFunctions.push({ 'fn': fn, 'action': action });
        // this.waitingFunction=fn;
        // this.action=action;
    }
    public removeWaitingFunction(fn: IWaitingFunction) {
        this.waitingFunctions = this.waitingFunctions.filter(obj => obj !== fn);
    }
}