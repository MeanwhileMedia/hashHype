if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'express',
	'http',
	'path',
	'socket.io',
	'child_process',
	
	'./routes/expressRoutes',
	'./routes/socketRoutes',
], function (express, http, path, socketIo, childProcess, expressRoutes, socketRoutes){
	
	var server = {
		
		///////
		init: function(){
			
			server.loadExpress();
			//server.listenSocketIo(); //optional
			//server.initRedisServer(); //optional
			
		},
		
		
		///////
		express: null,
		loadExpress: function(){
			
			// Create/configure the app
			server.express = express();
			server.express.configure(function(){
				server.express.set('port', 80);
				server.express.set('views', '../app');
				server.express.set('view engine', 'ejs'); //ejs: html templates
				
				server.express.use(express.favicon());
				server.express.use(express.logger('dev'));
				server.express.use(express.bodyParser());
				server.express.use(express.methodOverride());
				
				server.express.use(server.express.router); //not needed for socket.io only setup
				server.express.use(express.static(path.join(__dirname, 'assets'))); //domain.com/css/main.css = assets/css/main.css
			});
			server.express.configure('development', function(){
				server.express.use(express.errorHandler());
			});
			server.express.configure('production', function(){
				server.express.use(express.errorHandler()); 
			});
			
			//ititialize server
			server.listenServerPort();
			//server.enableCors(); //optional
			
			//Set up all of our express get/post requests routes
			expressRoutes.init(server.express); //required by define
			
		}, //end loadExpress
		
		
		///////
		openPort: null,
		listenServerPort: function(){
			
			server.openPort = http.createServer(server.express);
			server.openPort.listen( server.express.get('port') );
			
			console.log("hashHype server listening on port " + server.express.get('port') + ' in ' + process.env.NODE_ENV + ' mode.');
			
		}, //end listenServerPort
		
		
		///////
		enableCors: function(){
			
			//configure express router to allow cors for all incoming requests that match our 'Allow-Origin'
			//express.router MUST be enabled, and enableCors() MUST be called begore any other routes are defined
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
			
			
		}, //end enableCors
		
		
		//////
		socketIo: null,
		listenSocketIo: function(){
			
			// Start up socket.io, condigure environments
			server.socketIo = socketIo.listen( server.openPort );
			console.log("hashBack server listening on port " + server.express.get('port') + ' in ' + process.env.NODE_ENV + ' mode.');
			
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

		},
		
		redisServer: null,
		redisReconnCount: 0,
		initRedisServer: function(){
			
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
	
		} //end initRedisServer
		
	}
	
	server.init();
	
});