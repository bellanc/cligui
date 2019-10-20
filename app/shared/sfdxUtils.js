const child_process = require('child_process');
const logging = require('./logging.js');
const orgUtils = require('./orgUtils.js');
const fse=require('fs-extra');
const ui = require('./ui.js');
const path=require('path');

const runSFDXCommand = exports.runSfdxCommand = (command, params) => {
    let paramArr=[];
    if (''!=params) {
        if (params.charAt(0)==' ') {
            params=params.substring(1);
        }
        paramArr=params.replace(/(\\)?\ /g, function($0, $1){
            return $1 ? '\ ' : '[****]';
          }).split('[****]');          
    }
    paramArr.unshift(command);
    paramArr.push('--json');
    
    return runSFDX(paramArr);

}
const runSFDX = exports.runSfdx = (params) => {
    let result;
    try {
        console.log('Executing command sfdx ' + params);
        const resultJSON=child_process.execFileSync('sfdx', params, {stdio: ['pipe', 'pipe', 'pipe']});
        result=JSON.parse(resultJSON);
    }
    catch (exc) {
        console.log('Exception ' + exc);
        fse.closeSync(err);
        let stdoutJSON=exc.stdout.toString();
        if ( (stdoutJSON) && (stdoutJSON.length>0) ) {
            let stdout=JSON.parse(stdoutJSON);
            if ( (stdout.status) && (stdout.status!==0) ) {
                result=stdout;            
            }
        }
        else {
            const errMsg=exc.stderr.toString();
            let bracePos=errMsg.indexOf('{');
            if (-1!=bracePos) {
                resultJSON=errMsg.substring(bracePos);
                console.log('Result = ' + resultJSON);
                result=JSON.parse(resultJSON);
            }
            else {
                throw new Error('sfdx ' + JSON.stringify(params) + ' command failed [' + errMsg + '], orig = ' + exc);
            }
        }
    }
    
    console.log('Returning result = ' + JSON.stringify(result));

    return result;
}

const executeSfdxWithLogging = exports.executeSfdxWithLogging = (command, params, completeCB) => {
    logging.toggleModal();
    logging.log(command.startMessage);
    setTimeout(() => {
        let success=true;
        const result=runSFDXCommand(command.subcommand, params);
        if ( (result.status===0) && 
             ((!result.result.failures) || (0==result.result.failures.length)) ) {
            if (command.resultprocessor) {
                switch (command.resultprocessor) {
                    case 'loglist' :
                        outputLogListResult(result.result);
                        break;
                    ;;
                    case 'logfile':
                        outputLogFileResult(result.result);
                        break;
                    ;;
                }
            }
            else {
                for (let [key, value] of Object.entries(result.result)) {
                    logging.log(key + ' : ' + value);
                }
            }
        }
        else {
            success=false;
            if (result.message) {
                logging.log('Command failed ' + result.message);
            }
            else {
                if (result.result.failures)
                {
                    logging.log('Command failed');
                    for (let failure of result.result.failures) {
                        logging.log(failure.name + ' - ' + failure.message);
                    }    
                }
            }
        }

        if (success) {
            if ( (command.polling) && (command.polling.supported) ) {
                let username=orgUtils.getUsernameFromParams(command.params);
                switch (command.polling.type) {
                    case 'test':
                        let jobId=result.result.testRunId;
                        let interval=setInterval(() => {
                            let pollResult=runSFDXCommand('force:apex:test:report', '-i ' + jobId + ' -u ' + username + ' -w 2');
                            let stop=false;
                            let success=true;
                            if ( (pollResult.status===1) && (!pollResult.message.includes('timeout')) ) {
                                logging.log('Poll failed - ' + pollResult.message);
                                stop=true;
                                success=false;
                            }
                            else if ( (pollResult.status==0) || (pollResult.status==100) ) {
                                logging.log('Test run complete');
                                outputTestResults(pollResult.result);
                                stop=true;
                            }
                            if (stop) {
                                clearInterval(interval);
                                logging.log(command.completeMessage);
                                if (completeCB) {
                                    completeCB(success, result);
                                }
                            }
                        }, 30000);    
                        break;
                    ;;
                }
            }
            else {
                logging.log(command.completeMessage);
            }    
        }

        if ( ((!command.polling) || (!command.polling.supported)) && (completeCB) ) {
            completeCB(success, result);
        }
    }, 100);
}

const outputLogFileResult = (result) => {
    logging.log('------------- Log File Start -------------');
    logging.log(result.log);
    logging.log('------------- Log File End -------------');
}

const outputLogListResult = (result) => {
    for (let log of getLogList(result)) {
        logging.log(log);
    }
}

const getLogList = (result) => {
    let logEntries=[];
    let idx=0;
    for (let log of result) {
        logEntries.push(++idx + ' : ' + log.LogUser.Name + ' - ' + log.Operation + ' (' + log.LogLength + ') - ' + 
                    log.StartTime + ', ' + log.Status);
    }

    return logEntries;
}

const outputTestResults = (result) => {
    logging.log('Outcome', result.summary.outcome);
    logging.log('Tests Executed : ' + result.summary.testsRan);
    logging.log('Tests Passed   : ' + result.summary.passing);
    logging.log('Tests Failed   : ' +  result.summary.failing);

    let idx=1;
    if (0!==result.summary.passing) {
        logging.log('Passing : ');
        for (let test of result.tests)
        {
            if (test.Outcome==='Pass') {
                logging.log('  ' + idx + ') ' + test.ApexClass.Name + '.' + test.MethodName);
            }
        }
    }

    if (0!==result.summary.failing) {
        idx=1;
        logging.log('Failures : ');
        for (let test of result.tests)
        {
            if (test.Outcome!=='Pass') {
                logging.log('  ' + idx + ') ' + test.ApexClass.Name + '.' + test.MethodName + ' - ' + test.Message);
            }
        }
    }
}

const loadOrgs = exports.loadOrgs = (mainProcess, ele, force) => {
    console.log('Loading orgs');
    let filename=path.join(mainProcess.getDataDir(), 'orgs.json');
    console.log('looking for file ' + filename);
    console.log('Force = ' + force);
    if ( (fse.existsSync(filename)) && (!force) ) {
        const orgsResult = JSON.parse(fse.readFileSync(filename));
        console.log('Loading file ' + filename);
        orgs=orgsResult.result;
        mainProcess.setOrgs(orgs);
    }
    else {
        console.log('Retrieving orgs');
        const params=['force:org:list', '--json'];
        ui.executeWithSpinner(ele, () => {
            const result=runSFDX(params);
            if (result.status===0)  {
                fse.writeFileSync(filename, JSON.stringify(result));
                orgs=result.result;
                mainProcess.setOrgs(orgs);
            }    
            else {
                alert('Unable to load orgs ' + result.message);
            }
        });
    }
}

const getConfig = exports.getConfig = () => {
    let config={};
    console.log('Getting config settings');
    const params=['force:config:list', '--json'];

    const result=runSFDX(params);
    console.log('Config = ' + JSON.stringify(result));
    if ( (result.status===0) && (result.result.length>0) ) {
        for (let cfgItem of result.result) {
            switch (cfgItem.key) {
                case 'defaultdevhubusername' :
                    config.devhubusername=cfgItem.value;
                    break;
                ;;
                case 'defaultusername' :
                    config.username=cfgItem.value;
                    break;
                ;;
            }
        }
        console.log('Username = ' + config.username + ', devhub = ' + config.devhubusername);
    }

    return config;
}