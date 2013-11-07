define([
	'jquery',
	'underscore',
	'backbone',
	
	// Using text.js plugin to load our View template
  	'text!views/assets/templates/hashTagTop.html',
	'text!views/assets/templates/hashTagTop_pieSlice.html'
], function(
		jQuery, 
		_, 
		Backbone, 
		hashTagTopTemplate, 
		pieSliceTemplate
	){
	
	
	var hashTagTopPage = Backbone.View.extend({
		
		//add to main app div. 
		el: $(".hashHype"), 
		
		events: {
			//"click #showHashTop": "showHashTop"
		},
		
		//////////////
		render: function(app){
			console.log( 'HashHype top tags requested. App: ', app );
			
			//connect to hashBack via socket.io using the method stored in the app model
			app.get('connectHashBack')(app); //pass in self
			
			// Use Underscore to pass data to fill the html template with data
			var templateData = {};
			var compiledTemplate = _.template( hashTagTopTemplate, templateData );
			
			//view.$el: A cached jQuery object for the view's element (el).
			this.$el.append( compiledTemplate );
		},
		
		mapD3: function(app){	
			//This renders, and assigns style and attribute property functions for each hashTag slice (in our wheel)
			//D3 allows you to visualize realtime data, allow interactive exploration, and transition smoothly between datasets.
			
			//Test data
			var hashTags = [
				{ tag: '#indiana', count: 2435, tweets: ['etc', 'etc'] },
				{ tag: '#jones', count: 9876, tweets: [] },
				{ tag: '#marmalade', count: 8532, tweets: [] }
			];
			
			///////////
			// Sort the data array, each data set will be added to the page by D3 in sequential order.
			/// TODO
			
			/////////
			// Add them to the page, and apply dynamic styles using D3.
			d3.select('.hashHype').selectAll('.pieSlice') //.pieSlice will correspond to data, and they will be appended to .hashHype
				//data gets passed as argument into attribute and style functions bound below to each class member
				//If there are less elements on the page than data objects, the .enter() chain is called.
				//If there are more elements on the page than data objects, the .exit() chain is called.
				//For each data object with a corresponding element, the .update() chain is called.
				
				.data(hashTags)
				
					//we have an element that matches the index of this data object, 
					.text( function(d, i) { 
						return _.template( pieSliceTemplate, d ); 
					})
					
					.style("font-size", function(d, i) { //use the data (d) to set the font size. i = index in class (0 based)
						return d + "px"; 
					})
					
					.attr("cx", function(d, i) { //or x-position
						return d;
					})
					.attr("r", function(d, i) { //or radius 
						return Math.sqrt(d, i);
					})
					
				.enter() 
				
					//or we are creating a new element as our data objects have exceeded the count of elements present on page
					.append('.pieSlice')

				.exit() 
				
					//we are removing one (we have more elements that data objects)
					.transition() //apply a hide animation of some sort
						.duration(750)
						.delay(function(d, i) { 
							return i * 10; 
						})
						.style("opacity", function(d, i) { 
							return Math.sqrt(d * scale); 
						})
						
					.remove();

	
			

		},
		
		bind: function(app){	
			
		}
		
	});
	
	return hashTagTopPage;
	
});