if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'express',
	'http',
	'https',
	'path',
	'fs',
	'socket.io',
	'child_process',
	
	'./routes/expressRoutes',
	'./routes/socketRoutes',
], function (express, http, https, path, fs, socketIo, childProcess, expressRoutes, socketRoutes){
	
	var server = {
		
		/////////
		///Config
		
		enableSsl: true, //if enabled 443 must be unblocked
		sslCertsPath: __dirname+'/misc/ssl/', //the location of our ssl certificates
		forceSsl: true, //redirect all http requests to https (set false to serve both versions)
		
		enableCors: false,
		allowCorsWith: 'https://otherDomain.com', //cross origin domain that we allow in
		
		enableSocketIo: false,
		
		enableRedis: false,
		
		enableMongoDb: false, //TODO: no yet implemented
		
		enableGotHub: true, //autoupdate/restart server when there are new github commits
		
		
		
		//////////////
		///Init functions/stored created objects
		
		///////
		init: function(){
			
			server.loadExpress(); //create express server
			server.listenSocketIo();
			server.initMongoDb();
			server.initRedisServer();
			
		},
		
		///////
		express: null,
		loadExpress: function(){
			//this is the app directory, which will be 
			var appPath = path.resolve(__dirname, '..', 'app'); 
			
			// Create/configure the app
			server.express = express();
			server.express.configure(function(){
				//server.express.set('port', 80);

				server.express.use(express.logger('dev'));
				server.express.use(express.bodyParser());
				server.express.use(express.methodOverride());
				server.express.use(server.express.router);
				
				//Set the static path to that of our backbone app
				server.express.use( express.static(appPath) ); //domain.com/css/main.css = assets/css/main.css
			});
			server.express.configure('development', function(){
				server.express.use(express.errorHandler());
			});
			server.express.configure('production', function(){
				server.express.use(express.errorHandler()); 
			});
			
			//ititialize server
			server.listenServerPort();
			
			//Set up all of our express get/post requests routes
			expressRoutes.init(server); //required by define
			
		}, //end loadExpress
		
		
		///////
		activeHttpPort: null,
		activeHttpsPort: null,
		requestWasHttps: false,
		listenServerPort: function(){
			
			console.log("Starting hashHype server.");
			
			if ( server.enableSsl ){
				console.log("SSL enabled.");
				//listen on 443, serve credentials
				//To force SSL only, an express route redirect is required. Set forceSsl above to enable.
				var sslCert = server.getSslCert();
				server.activeHttpsPort = https.createServer(server.express);
//				server.activeHttpsPort = bouncy(sslCert, function (req, res, bounce) {
//					server.requestWasHttps = true;
//					bounce(80);
//				});
				server.activeHttpsPort.listen(443)
			}
			
			server.activeHttpPort = http.createServer(server.express);
			server.activeHttpPort.listen( 80 );
			
			if ( server.enableCors ){
				server.initCors();
			}
			
		}, //end listenServerPort
		getSslCert: function(){
			
			function bundleCa(caFiles){
				var _i, _len, _results;
				_results = [];
				for (_i = 0, _len = caFiles.length; _i < _len; _i++) {
					file = caFiles[_i];
					_results.push(fs.readFileSync(file));
				}
				return _results;
			}
			
			var sslCert = {
				key : fs.readFileSync(server.sslCertsPath+'private.key'),
				cert : fs.readFileSync(server.sslCertsPath+'server.crt'),
				ca: bundleCa([server.sslCertsPath+'PositiveSSLCA2.crt', server.sslCertsPath+'AddTrustExternalCARoot.crt']),
			};
			
			return sslCert;
			
		}, //end getSslCert
		
		
		///////
		initCors: function(){
			
			//configure express router to allow cors for all incoming requests that match our 'Allow-Origin'
			//express.router MUST be enabled, and openCors() MUST be called before any other routes are defined
			server.express.all('*', function(req, res, next){
				console.log('New incoming request: ', req);
				
				res.header("Access-Control-Allow-Origin", "https://hashhype.com");
				res.header("Access-Control-Allow-Headers", "X-Requested-With");
				
				if (req.method.toUpperCase() === "OPTIONS"){
					res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
					res.header("Access-Control-Max-Age", 3600); // Seconds.
					res.writeHead(200, { 'content-type' : 'text/plain' } ); //Send success code					
					res.end();
				} else {
					next();
				}
				
			});
			//also serve crossdomain.xml if necc (flash).
			server.express.get('/crossdomain.xml', function(req, res){
				console.log('Crossdomain.xml requested.');
				res.send("<?xml version='1.0' ?>\n\
				<!DOCTYPE cross-domain-policy SYSTEM 'http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd'>\n\
				<cross-domain-policy>\n\
				<allow-access-from domain='hashhype.com' />\n\
				</cross-domain-policy>\n");
			});
			
			console.log('CORS enabled.');
		}, //end enableCors
		
		
		//////
		socketIo: null,
		listenSocketIo: function(){
			if (!server.enableSocketIo){ return; }
			
			// Start up socket.io, condigure environments
			server.socketIo = socketIo.listen( server.openPort );

			server.socketIo.configure('development', function(){ //define development environment for io
				io.set('transports', ['websocket']);
			});
			
			server.socketIo.configure('production', function(){ //define production environment for io
				server.socketIo.enable('browser client minification');  // send minified client
				server.socketIo.enable('browser client etag');          // apply etag caching logic based on version number
				server.socketIo.enable('browser client gzip');          // gzip the file
				//io.set('origins', 'https://mean.to');      // Needed for cross domain
				server.socketIo.set('log level', 1);                    // reduce logging
				server.socketIo.set('transports', [                     // enable all transports (optional if you want flashsocket)
					'websocket'
				  , 'flashsocket'
				  , 'htmlfile'
				  , 'xhr-polling'
				  , 'jsonp-polling'
				]);
			});
			
			// When a new socket connection comes in, we attach our routes to it
			server.socketIo.sockets.on('connection', function (socket) {
				console.log("New incoming socket connection to hashBack. socket: ", socket);
				
				//Init our socket listener routes
				socketRoutes.init(socket); //required at define
				
				socket.emit('connectResponse', { status: 'success' }); //let client know we are good to go
			});
			
			console.log('socket.io enabled.');
		}, //end listenSocketIo
		
		
		////////
		MongoDb: null,
		initMongoDb: function(){
			if (!server.enableMongoDb){ return; }
			
			console.log('MongoDb enabled.');
		},
		
		
		////////
		redisServer: null,
		redisReconnCount: 0,
		initRedisServer: function(){
			if(!server.enableRedis){ return; }
			
			
			server.redisServer = childProcess.spawn('/etc/progs/redis-2.4.2/src/redis-server', ['/etc/progs/redis-2.4.2/redis.conf']);
	
		//	server.redisServer.stdout.on('data', function (data) {
		//		if ( data.toString().indexOf('The server is now ready') != -1 ){
		//			console.log(data.toString());
		//		}
		//	});
			
			server.redisServer.stderr.on('data', function (data) {
				console.log('Redis server error: ' + data.toString());
			});
			
			server.redisServer.on('exit', function (code) {
				if (server.redisReconnCount == 0){
					server.redisServer = null;
					console.log('Redis server exited with code: ' + code + '. Attempting restart.');
				}
				
				if (server.redisReconnCount < 4){
					server.redisReconnCount++;
					console.log('Redis reconnect attempt: '+ server.redisReconnCount);
					server.initRedisServer();
				} else {
					server.redisReconnCount = 0;
					console.log('Could not reconnect redis server.');
				}
			});
			
			console.log('Redis enabled.');
		}, //end initRedisServer
		
		
		////////
		gotHubPass: 'd8Syd3M',
		gotHubPullOrigin: path.resolve(__dirname, '..', '..'), //when a gotHub request comes in, pull to this directory
		gotHubPullBranch: 'master',
		//make restarting the server with forever easier
		selfPath: path.resolve(__dirname, __filename),
		foreverPath: path.resolve(__dirname, 'forever.js')
	
	}
	
	server.init();
	
});