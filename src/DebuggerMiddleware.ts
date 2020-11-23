interface IWaitingFunction {
    fn: Function;
    action: string;
}


export class DebuggerMiddleware {
    private waitingFunctions: IWaitingFunction[] = [];
    //private action:string="";
    public onData(str: string) {

        this.waitingFunctions.forEach(waitingFunction => {
            if (waitingFunction !== null) {
                if (waitingFunction.action !== "") {
                    if (waitingFunction.action === "runInfo") {
                        if (str.includes("Hit breakpoint")) {
                            waitingFunction.fn(str);

                            this.removeWaitingFunction(waitingFunction);
                            //waitingFunction.fn=()=>{};
                        }
                    }
                    if (waitingFunction.action === "variablesInfo") {
                        if (str.includes("Locals:") || str.includes("No app is suspended.") || str.includes('No locals.')) {
                            waitingFunction.fn(str);

                            this.removeWaitingFunction(waitingFunction);
                        }

                    }
                    if (waitingFunction.action === "frameInfo") {
                        if (str.includes("Stack level")) {
                            waitingFunction.fn(str);

                            this.removeWaitingFunction(waitingFunction);
                        }

                    }
                    if (waitingFunction.action === "nextInfo"){
                        if (str.startsWith('#')) {
                            waitingFunction.fn(str);
                            this.removeWaitingFunction(waitingFunction);
                        }
                    }
                    if (waitingFunction.action.startsWith('childVariablesInfo') ||/No symbol ".*" in current context./.test(str)) {
                        if (str.startsWith(waitingFunction.action.split('_')[1])) {
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