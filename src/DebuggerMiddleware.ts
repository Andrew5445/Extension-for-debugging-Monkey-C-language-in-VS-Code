
export class DebuggerMiddleware{
    private waitingFunction;
    private action:string="";
    public onData(str:string){
        if (this.waitingFunction!==null){
            if (this.action!==""){
            if (this.action==="runInfo"){
                if (str.includes("Hit breakpoint")){
                    this.waitingFunction(str);
                    this.action="";
                    this.waitingFunction=null;
                }
            }
            if (this.action==="variablesInfo"){
                if (str.includes("Locals:")||str.includes("No app is suspended.")){
                    this.waitingFunction(str);
                    this.action="";
                    this.waitingFunction=null;
                }
                
            }
        }
        }
        

    }
    public waitForData(fn,action:string){
        this.waitingFunction=fn;
        this.action=action;
    }
}