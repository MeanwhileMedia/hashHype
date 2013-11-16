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
			
			//Test data
			var hashTags = [
				{ tag: '#indiana', count: 2435, tweets: ['etc', 'etc'] },
				{ tag: '#jones', count: 9876, tweets: [] },
				{ tag: '#marmalade', count: 8532, tweets: [] }
			];
			
			//////////
			//Prepare the data for the d3 partition layout. Name, and children to infinite depth
			var wheelTree = { 
				"name": "flare",
				"children": hashTags
			};

			
			//////////
			///Main Wheel sizing
			var width = 800; //main SVG container
			var height = 800;
			var radius = Math.min(width-200, height-200)*.5; //inner wheel (add 200px padding)
			var color = d3.scale.category20c();
			
			//add our main svg element, and our group element (g)
			var svg = d3.select(".topWheel") 
				.append("svg")
					.attr("width", width)
					.attr("height", height)
					.append("g")
						.attr("transform", "translate(" + width*.5 + "," + height*.5 + ")"); //center our shape (defaults to 0,0)
			
			
			////////////
			//D3 Partition layout
			//The partition object is given a .nodes array property. Each node represents a .children object of the data we passed.
			var partition = d3.layout.partition()
				.sort(null)
				.size([2 * Math.PI, radius * radius])
				.value(function(d) { //Value represents each nodes portion of the circle
					return d.count; 
				});

			//There are severtal properties added to our data to make the d3 partition object:
			
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
				.startAngle(function(d) { //Start and end angles define the width of the partition, or it's share of the circle
					return d.x; 
				})
				.endAngle(function(d) { 
					return d.x + d.dx; 
				})
				.innerRadius(function(d) { //A lower number would make the partition's bottom edge extend further inward
					return Math.sqrt(d.y) - Math.floor((Math.random()*100)+1); 
				})
				.outerRadius(function(d) { //A larger outer radius creates longer partitions to jut out
					return Math.sqrt(d.y + d.dy) + Math.floor((Math.random()*100)+1); 
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
						

			///////////
			//Now set up listeners to transition data changes
			d3.select(".topWheel").on("click", function(){
				
				var currentValue = function(d){
					console.log(d);
					
					//We are updating the .value property for each of our partitions.
					return d.count + Math.floor((Math.random()*1000)+1);
					
				}
				
				
				
				path //update path, our group of partitions which are bound to our data set
					.data(partition.value(currentValue).nodes)
						.transition()
							.duration(1500)

							// Interpolate the arcs in data space.
							.attrTween("d", function(a) {
								var i = d3.interpolate({x: a.x0, dx: a.dx0}, a);
								return function(t) {
									var b = i(t);
									a.x0 = b.x;
									a.dx0 = b.dx;
									return arc(b);
								};
							});
					
			}); //end d3.selectAll("input").on("change"
			
			


		},
		
		bind: function(app){	
			
		}
		
	});
	
	return hashTagTopPage;
	
});