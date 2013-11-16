define([
	'jquery',
	'underscore',
	'backbone',
	'd3',
	
	// Using text.js plugin to load our View template
  	'text!views/assets/templates/hashTagTop.html',
	'text!views/assets/templates/hashTagTop_pieSlice.html'
], function(
		jQuery, 
		_, 
		Backbone,
		d3,
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
			
			this.mapD3(app);
		},
		
		mapD3: function(app){	
			//This renders, and assigns style and attribute property functions for each hashTag slice (in our wheel)
			//D3 allows you to visualize realtime data, allow interactive exploration, and transition smoothly between datasets.
			
			//Test data - value is the only required attribute for the partition layout
			var hashTags = [
				{ tag: '#indiana', value: 5000, rank: 1, tweets: ['etc', 'etc'] },
				{ tag: '#jones', value: 3500, rank: .7, tweets: [] },
				{ tag: '#marmalade', value: 2500, rank: .5, tweets: [] }
			];
			
			
			//////////
			//Prepare the data for the d3 partition layout. Name, and children to infinite depth
			var wheelTree = { 
				"name": "flare",
				"children": hashTags
			};

			
			//////////
			///Main Wheel sizing
			var outerRadius = 400; //the outermost radius (reached by our hashtag with the highest value
			var innerRadius = 100; //the radius of the empty space in the middle of the wheel
			
			var color = d3.scale.category20c();
			
			//add our main svg element, and our group element (g)
			var svg = d3.select(".topWheel") 
				.append("svg")
					.attr("width", outerRadius*2)
					.attr("height", outerRadius*2)
					.append("g")
						.attr("transform", "translate(" + outerRadius + "," + outerRadius + ")"); //center our shape (defaults to 0,0)
			
			
			////////////
			//D3 Partition layout
			//The partition object is given a .nodes array property. Each node represents a .children object of the data we passed.
			var partition = d3.layout.partition()
				.sort(null)
				.size([2 * Math.PI, innerRadius * innerRadius])
//				.value(function(d) { //Value represents each nodes portion of the circle
//					return d.count; 
//				});


			//There are several properties added to our data to make the d3 partition object:
			
//			parent - the parent node, or null for the root.
//			children - the array of child nodes, or null for leaf nodes.
//			value - the node value, as returned by the value accessor.
//			depth - the depth of the node, starting at 0 for the root.
//			x - the minimum x-coordinate of the node position.
//			y - the minimum y-coordinate of the node position.
//			dx - the x-extent of the node position.
//			dy - the y-extent of the node position.

			///////
			//Create an arc to define the size of this hashtag's partition
			var arc = d3.svg.arc()
				.startAngle(function(d, i) { //Start and end angles define the width of the partition, or it's share of the circle
					return d.x; 
				})
				.endAngle(function(d, i) { 
					return d.x + d.dx; 
				})
				.innerRadius(function(d, i) { //A lower number would make the partition's bottom edge extend further inward
					//console.log(Math.sqrt(d.y));
					return innerRadius; //we are currently keeping a consistent inner radius
				})
				.outerRadius(function(d, i) { //A larger outer radius creates longer partitions to jut out
					//console.log(Math.sqrt(d.y + d.dy); 
					console.log(d, i);
					return ((outerRadius-innerRadius)*d.rank) + innerRadius;
				});
			
			//the partitions are rendered on the page. Define styles, add content, etc. Path can be referenced at any time to change/update our data set.
			var path = svg.datum(wheelTree).selectAll("path")
				.data(partition.nodes)
					.enter().append("path") 
						.attr("display", function(d) { return d.depth ? null : "none"; }) // hide inner ring
						.attr("d", arc)
						.style("stroke", "#fff")
						.style("fill", function(d) { return color(d.tag); })
						.style("fill-rule", "evenodd")
						
						// Stash the old values for transition.
						.each( function(d){
							d.x0 = d.x;
			  				d.dx0 = d.dx;
						});
						
						
			console.log('Current hashTag partitions: ', wheelTree.children);
			
			///////////
			//Now set up listeners to transition data changes
			d3.select(".topWheel").on("click", function(){
				
/*				var currentValue = function(d){
					//We are updating the .value property for each of our partitions.
					return d.count + Math.floor((Math.random()*1000)+1);
				}*/
				
				path //update path, our group of partitions which are bound to our data set
					//.data(partition.value(currentValue).nodes)
					.data(partition.nodes)
						.transition()
							.duration(1500)

							//Smoothly transition between two attribute values.
							//current datum = d, the current index = i and the current attribute value = a
							.attrTween("d", function(d, i, a) {

								//interpolate maps a parametric value t in the domain [0,1] to a color, number or arbitrary value.
								//use the x0 and dx0 which were stashed (see above)
								var transPath = d3.interpolate(
									{  //old values
										x: a.x0, 
										dx: a.dx0
									}, //New values
										a
									);
								
								//The returned value to attrTween must be a function which will return 
								//attribute values at any point (t) in our transition path 
								return function(t) { 
									//use t, in the range [0,1] to retreive our current attribute value
									var b = transPath(t);
									
									//Update our stashed old values as the transition progresses
									a.x0 = b.x;
									a.dx0 = b.dx;
									
									//arc (above) returns the path data string for the specified datum
									return arc(b, i);
								};
							});
					
			}); //end d3.selectAll("input").on("change"
			
			


		},
		
		bind: function(app){	
			
		}
		
	});
	
	return hashTagTopPage;
	
});