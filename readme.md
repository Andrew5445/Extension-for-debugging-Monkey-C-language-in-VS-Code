Installation setup
* Install the Connect IQ SDK from https://developer.garmin.com/connect-iq/sdk/.
* Open SDK manager and download SDK version 3.2.3 and set it as current version.
* Go to devices and download all of the available devices.
* Open Visual Studio Code and install extension Monkey C from Alexander Fedora.
* Install debugger extension from the .vsix file.
* Clone a Connect IQ project to debug, e.g. https://github.com/okdar/smartarcsactive
* (optional) Go to Run and Debug section and click on create a launch.json file. 
* Open command palette, find and execute command Configure Monkey C debugger".
* Fill in the form and set the project and SDK path.
* Press F5 and select Monkey C, then target device.

You can now debug the Connect IQ application.

