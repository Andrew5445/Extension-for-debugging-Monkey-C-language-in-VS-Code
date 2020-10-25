interface IwaitingFunction{
    fn:Function;
    action:string;

}


export class DebuggerMiddleware{
    private waitingFunctions:IwaitingFunction[]=[];
    //private action:string="";
    public onData(str:string){
        
        this.waitingFunctions.forEach(waitingFunction => {
            if (waitingFunction!==null){
                if (waitingFunction.action!==""){
                if (waitingFunction.action==="runInfo"){
                    if (str.includes("Hit breakpoint")){
                        waitingFunction.fn(str);
                        
                        this.removeWaitingFunction(waitingFunction);
                        //waitingFunction.fn=()=>{};
                    }
                }
                if (waitingFunction.action==="variablesInfo"){
                    if (str.includes("Locals:")||str.includes("No app is suspended.")|| str.includes('No locals.')){
                        waitingFunction.fn(str);
                        
                        this.removeWaitingFunction(waitingFunction);
                    }
                    
                }
            }
            }
        });
        
    

    }
    public waitForData(fn,action:string){
        this.waitingFunctions.push({'fn':fn,'action':action});
        // this.waitingFunction=fn;
        // this.action=action;
    }
    public removeWaitingFunction(fn:IwaitingFunction){
        this.waitingFunctions=this.waitingFunctions.filter(obj => obj !== fn);
    }
}