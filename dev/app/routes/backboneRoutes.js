define([
	'../views/hashTagTopPage',
], function (hashTagTopPage){
	
	var routes = {
		init: function(app){
			
			///////////
			// Route listeners
			app.get('router').on('route:showHashTop', function(){
				console.log('View requested: showHashTop');
				
				var hashTagTopView = new hashTagTopPage();
				hashTagTopView.render(app);
			});
			
		}
	};
	
	return routes;
	
});