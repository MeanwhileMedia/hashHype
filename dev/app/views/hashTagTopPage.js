define([
	'jquery',
	'underscore',
	'backbone',
	
	// Using text.js plugin to load our View template
  	'text!views/assets/templates/hashTagTop.html'
], function(jQuery, _, Backbone, hashTagTopTemplate){
	
	var hashTagTopPage = Backbone.View.extend({
		
		//add to main app div. 
		el: $(".hashHype"), 
		
		events: {
			//"click #showHashTop": "showHashTop"
		},
		
		render: function(app){
			console.log( 'HashHype top tags requested. App: ', app );
			
			//connect to hashBack via socket.io using the method stored in the app model
			//app.hashBackSocket = app.get('connectHashBack')();
			
			// Use Underscore to pass data to fill the html template with data
			var templateData = {};
			var compiledTemplate = _.template( hashTagTopTemplate, templateData );
			
			this.$el.append( compiledTemplate );
		}
		
	});
	
	return hashTagTopPage;
	
});