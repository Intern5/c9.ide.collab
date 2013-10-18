/**
 * File Finder module for the Cloud9 IDE that uses nak
 *
 * @copyright 2012, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
define(function(require, exports, module) {
    main.consumes = ["c9", "Plugin", "ext", "ui", "proc"];
    main.provides = ["collab.connect"];
    return main;

    function main(options, imports, register) {
        var Plugin   = imports.Plugin;
        var c9       = imports.c9;
        var ext      = imports.ext;
        var ui       = imports.ui;
        var proc     = imports.proc;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit   = plugin.getEmitter();

        // 0 - production
        // 1 - development
        // 2 - tracing
        var DEBUG;
        if (typeof options.DEBUG !== "undefined")
            DEBUG = options.DEBUG;
        else if (typeof window !== "undefined") // browser
            DEBUG = Number((/debug=(\d)/.exec(window.location.search) || [null, DEBUG])[1]);
        else
            DEBUG = 0;

        var CODE   = require("text!./server/collab-server.js");
        var markup = require("text!./connect.xml");

        // UI Elements
        var winCollabInstall, collabInstallTitle, collabInstallMsg, btnCollabInstall, btnCollabDisable;

        var SSH_CHECKS = [
            'echo "`command -v sqlite3`"',
            'NODE_PATH=' + options.nodePath + ' ' + options.nodeBin +' -e ' +
             '"try { require(\'sqlite3\'); require(\'sequelize\'); console.log(true); } catch(e) { console.log(false); }"',
            '',
            'BIN_DIR=$(dirname `which '  + options.nodeBin + '`)',
            'export PATH=$BIN_DIR:$PATH', // hack on nvm installed node versions
            'NPM_BIN=$(which npm)',
            'echo "mkdir -p ' + options.nodePath + '"', // result[2]
            'echo "$NPM_BIN --prefix ' + options.nodePath + ' install sequelize@1.6.0-beta4"', // result[3]
            'echo "$NPM_BIN --prefix ' + options.nodePath + ' install sqlite3@2.1.7"', // result[4]
            // result[5]
            'case `uname` in',
            '  Linux )',
            '     command -v apt-get >/dev/null && { echo "sudo apt-get -y install sqlite3"; exit; }',
            '     command -v yum >/dev/null && { echo "sudo yum install sqlite3"; exit; }',
            '     command -v zypper >/dev/null && { echo "sudo zypper in sqlite3"; exit; }',
            '     ;;',
            '  Darwin )',
            '     echo "sudo port install sqlite3"',
            '     ;;',
            'esac'
        ].join("\n");

        var collab;
        var collabInstalled = !options.isSSH;
        var connecting      = false;
        var connected       = false;
        var CONNECT_TIMEOUT = 30000;
        var connectMsg;
        var connectTimeout;

        var loaded = false;
        function load(){
            if (loaded) return;
            loaded = true;

            if (c9.connected)
                connect();

            c9.on("connect", connect);
            c9.on("disconnect", onDisconnect);
        }

        var extended = false;
        function extendCollab(callback) {
            if (extended)
                return plugin.once("available", callback);
            extended = true;
            ext.loadRemotePlugin("collab", {
                code     : CODE,
                redefine : true
            }, function(err, api){
                if (err) {
                    extended = false;
                    return callback(err);
                }
                collab = api;

                emit("available");
                callback();
            });
        }

        function onDisconnect() {
            if (connected || connecting)
                emit("disconnect");
            else
                console.error("[OT] Already disconnected !!");
            connecting = connected = extended = false;
            collab = null;
            clearTimeout(connectTimeout);
        }

        var drawn = false;
        function draw() {
            if (drawn) return;
            drawn = true;

            ui.insertMarkup(markup);

            // btnCollabDisable.on("click". function(){
            //    destroy();
            //    winCollabInstall.hide();
            //}
        }
        
        /***** Methods *****/

        function connect() {
            if (connected)
                onDisconnect();

            if (connecting)
                return;

            connecting = true;
            console.log("Collab connecting");
            emit("connecting");
            connectTimeout = setTimeout(function(){
                connecting = false;
                if (!connected) {
                    console.warn("[OT] Collab connect timed out ! - retrying ...");
                    connect();
                }
            }, CONNECT_TIMEOUT);

            extendCollab(function(err){
                if (err)
                    return console.error("COLLAB CONNECT ERR", err);
                if (collabInstalled)
                    return doConnect();

                sshCheckInstall();
            });
        }

        function doConnect() {
            var userIds = {
                clientId: "abc",
                userId: "1",
                email: "email@something.com",
                fullname: "Mostafa",
                fs: "rw"
            };
            collab.connect(options.pid, options.basePath, userIds, function (err, meta) {
                if (err)
                    return console.error("COLLAB connect failed", err);
                console.log("COLLAB connected -", meta.isMaster ? "MASTER" : "SLAVE");
                clearTimeout(connectTimeout);

                var stream = meta.stream;
                var isClosed = false;
                function onData(data) {
                    data = JSON.parse(data);
                    if (DEBUG)
                        console.log("[OT] RECEIVED FROM SERVER", data);
                    emit("message", data);
                }
                function onConnect(data) {
                    data = JSON.parse(data);
                    if (DEBUG)
                        console.log("[OT] RECEIVED FROM SERVER", data);
                    if (data.type !== "CONNECT")
                        return console.error("[OT] Invalid connect data !", data);
                    connected  = true;
                    connecting = false;
                    connectMsg = data;
                    console.log("Collab connected");
                    emit("connect", data);
                    stream.on("data", onData);
                }
                stream.once("data", onConnect);
                function onClose () {
                    if (isClosed)
                        return;
                    stream.off("data", onData);
                    stream.destroy();
                    isClosed = true;
                    onDisconnect();
                }
                stream.once("end", function (){
                    console.log("COLLAB STREAM END");
                    onClose();
                });
                stream.once("close", function(){
                    console.log("COLLAB STREAM CLOSE");
                    onClose();
                });
            });
        }

        function send(msg) {
            if (typeof arguments[0] !== "object")
                msg = {type: arguments[0], data: arguments[1]};
            if (!connected)
                return console.log("[OT] Collab not connected - SKIPPING ", msg);
            if (DEBUG)
                console.log("[OT] SENDING TO SERVER", msg);
            collab.send("abc", msg);
        }

        function sshCheckInstall() {
            console.log("COLLAB CHECKS", SSH_CHECKS);
            proc.execFile("bash", {args: ["-c",
                SSH_CHECKS
            ]}, function (err, stdout, stderr) {
                if (err)
                    return console.log("COLLAB-PLUGIN SSH check install failed:", err, stderr);

                var result = stdout.split("\n");

                var missingSqlite = !result[0];
                var missingModules = result[1] === "false";
                if (missingSqlite || missingModules) {
                    draw();
                    var title = "Missing SQLite and/or dependency modules";
                    var installationSteps = [];
                    if (missingModules)
                        installationSteps.push(result[2], result[3], result[4]);
                    if (missingSqlite)
                        installationSteps.push(result[5]);
                    var body = "Cloud9 collaboration features need <b>sqlite3</b> to be available on your workspace.</br></br>" +
                        "Please install them and reload:</br>" +
                        "<p style='font-familt: monospace;'>&nbsp;&nbsp;$ " + installationSteps.join("<br/>&nbsp;&nbsp;$ ") + "</p>" +
                        "<b>Please note that your files won't be accessible during that 1-minute installation</b>";
                    var cmds = installationSteps.join(";\n") + "\n";
                    // TODO popup

                    c9console.showConsoleTerminal();
                    showCollabInstall(title, body);

                    btnCollabInstall.addEventListener("click", function installerClick() {
                        btnCollabInstall.removeEventListener("click", installerClick);
                        var consoleCmdInterv = setInterval(function () {
                            var term = c9console.terminal;
                            if (!term || !term.fd || term.reconnecting || term.restoringState || term.terminated)
                                return console.warn("[OT] Waiting terminal to connect -- cmd:", msg.console);
                            term.send(msg.console + " ; \n"); // execute the command
                            winCollabInstall.hide();
                            clearInterval(consoleCmdInterv);

                            var npmBinaryDelay = msg.console.indexOf("npm") !== -1;

                            setTimeout(function() {
                                util.alert("Collaboration Features", "Install finished?!", "Done installation? - Please reload to enjoy Collaboration features!");
                            }, npmBinaryDelay ? 90000 : 30000);
                        }, 300);
                    });
                }
                else {
                    collabInstalled = true;
                    doConnect();
                }
            });
        }

        function showCollabInstall(title, body) {
            winCollabInstall.show();
            collabInstallTitle.$ext.innerHTML = msg.title;
            collabInstallMsg.$ext.innerHTML = msg.body;
        }

        /***** Lifecycle *****/
        plugin.on("load", function(){
            load();
        });
        plugin.on("enable", function(){

        });
        plugin.on("disable", function(){

        });
        plugin.on("unload", function(){
            loaded = false;
        });

        // Make sure the available event is always called
        plugin.on("newListener", function(event, listener){
            if (event == "connect" && connected && connectMsg)
                listener(null, connectMsg);
        });

        /***** Register and define API *****/

        /**
         * Finder implementation using nak
         **/
        plugin.freezePublicAPI({
            get DEBUG()     { return DEBUG; },
            get connected() { return connected; },

            send: send
        });
        
        register(null, {
            "collab.connect": plugin
        });
    }
});