require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module
	paths: {
		'jquery': 'web_modules/jquery/jquery',
		'underscore': 'web_modules/underscore-amd/underscore',
		'backbone': 'web_modules/backbone-amd/backbone',
		'socketio': 'web_modules/socket.io-client/dist/socket.io',
		'text': 'web_modules/text/text'
	}
});

require([
	// Load our app module and pass it in
	'router',
	'models/app'
], function(router, app){
	console.log('hashHype Commencing... ', app);
	//The app model stores persistent functions and 'global' properties such as socket.io, and the router
	
	//Start up the router, send the user to appropriate view
	router.initialize(app);
});