require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module (non AMD)
	shim: {
		'd3': {
			exports: 'd3' //This will tell requirejs to use the global d3 as the module value for d3.
		},
	},
	
	paths: {
		'jquery': 'web_modules/jquery/jquery',
		'underscore': 'web_modules/underscore-amd/underscore',
		'backbone': 'web_modules/backbone-amd/backbone',
		'socket.io': 'web_modules/socket.io-client/dist/socket.io',
		'text': 'web_modules/text/text',
		'd3': 'web_modules/d3/d3'
	}
});

require([
	'backbone', 
	'socket.io',
	
	'./routes/backboneRoutes',
	'./routes/socketRoutes_hashBack'
], function(backbone, socketIo, backboneRoutes, socketRoutes_hashBack){
	
	var appModel = Backbone.Model.extend({
		
		defaults: {
			
			//////
			init: function(app){
			
				console.log('hashHype Commencing... ', app);
				
				app.get('initRouter')(app); //we pass the app model along to every route/view
				
			}, //end initialize
		
			
			/////
			router: null,
			initRouter: function(app){
				
				//automatically launch the router when this file is required,
				//and return the initialized/defined router object
				var backboneRouter = backbone.Router.extend({
					routes: {
						// Define some URL routes
						'top': 'showHashTop',
					
						// Default
						'*actions': 'showHashTop'
					}
				});
				
				app.set('router', new backboneRouter);
				console.log('App router initialized.');
				
				//Set our backbone routes
				backboneRoutes.init(app); //required at define
						
				//For history API, and to route to our initial request
				Backbone.history.start();
				
			}, //end initRouter
			
			
			///////
			hashBackSocket: null,
			connectHashBack: function(app){
				
				//The user just landed on a page that needs to send/receive updates from the hashBack server
				//update the apps hashBackSocket property with an active connection. 
				//Individual views will bind to .on events on the socket
				if ( app.hashBackSocket == null ){
					console.log( 'Attempting a connection to hashBack via socket.io.');
					app.hashBackSocket = socketIo.connect('https://hashBack.hashHype.com');
					
					//wait for connection confirmation
					app.hashBackSocket.on('connectResponse', function (data) {
						console.log('hashBack connection response: ', data, app.hashBackSocket );
						
						//Init our socket listener routes
						socketRoutes_hashBack.init(app.hashBackSocket); //required at define
					});
				}
				
			} //end connectHashBack

		} //end defaults
	}); //end new backbone.Model
	
	var hashHype = new appModel();
	hashHype.get('init')(hashHype); //send an instance of self to pass around app

});