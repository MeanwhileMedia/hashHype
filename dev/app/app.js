require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module
	paths: {
		'jquery': 'web_modules/jquery/jquery',
		'underscore': 'web_modules/underscore-amd/underscore',
		'backbone': 'web_modules/backbone-amd/backbone',
		'socket.io': 'web_modules/socket.io-client/dist/socket.io',
		'text': 'web_modules/text/text'
	}
});

require([
	'backbone', 
	'socket.io',
	
	'./routes/backboneRoutes',
	'./routes/socketRoutes_hashBack'
], function(backbone, socketIo, backboneRoutes, socketRoutes_hashBack){
	
	var app = Backbone.Model.extend({
		
		defaults: {
			
			//////
			init: function(self){
			
				console.log('hashHype Commencing... ', self);
				
				self.get('initRouter')(self); //we pass the app model along to every route/view
				
			}, //end initialize
		
			
			/////
			router: null,
			initRouter: function(appModel){
				
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
				
				appModel.set('router', new backboneRouter);
				console.log('App router initialized.');
				
				//Set our backbone routes
				backboneRoutes.init(appModel); //required at define
						
				//For history API, and to route to our initial request
				Backbone.history.start();
				
			}, //end initRouter
			
			
			///////
			hashBackSocket: null,
			connectHashBack: function(){
				
				//The user just landed on a page that needs to send/receive updates from the hashBack server
				//update the apps hashBackSocket property with an active connection. 
				//Individual views will bind to .on events on the socket
				if ( this.hashBackSocket == null ){
					console.log( 'Attempting a connection to hashBack via socket.io.');
					this.hashBackSocket = socketIo.connect('https://hashBack.hashHype.com');
					
					//wait for connection confirmation
					this.hashBackSocket.on('connectResponse', function (data) {
						console.log('hashBack connection response: ', data, this.hashBackSocket );
						
						//Init our socket listener routes
						socketRoutes_hashBack.init(self.hashBackSocket); //required at define
					});
				}
				
			} //end connectHashBack

		} //end defaults
	}); //end new backbone.Model
	
	var hashHype = new app();
	hashHype.get('init')(hashHype); //send an instance of self to pass around app

});