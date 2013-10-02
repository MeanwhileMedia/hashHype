define([
  //'jquery',
  //'underscore',
  'backbone',
  'views/hashTagTopPage'
], function(Backbone, hashTagTopPage){
	
	//automatically launch the router when this file is required,
	//and return the initialized/defined router object
	var backboneRouter = Backbone.Router.extend({
		routes: {
			// Define some URL routes
			'top': 'showHashTop',
		
			// Default
			'*actions': 'showHashTop'
		}
	});
	
	var initialize = function(app){
		var router = new backboneRouter;
		console.log('Router initialized.');

		//update our app model
		app.set('router', router);
		
		///////////
		// Route listeners
		router.on('route:showHashTop', function(){
			console.log('View requested: showHashTop');
			
			var hashTagTopView = new hashTagTopPage();
			hashTagTopView.render(app);
		});
		
		
		//For history API, and to route to our initial request
		Backbone.history.start();
	}
	
	//Create our return object
	return {
		initialize: initialize
	};

});