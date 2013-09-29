require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module
	paths: {
		'jquery': 'vendor/jquery/jquery',
		'underscore': 'vendor/underscore-amd/underscore',
		'backbone': 'vendor/backbone-amd/backbone',
		'socketio': 'vendor/socket.io-client/dist/socket.io'
	}
});

require(['views/app'], function(hashHypeApp) {
	var app = new hashHypeApp; //start up the app, and set it global from main.js
	app.init(app);
});