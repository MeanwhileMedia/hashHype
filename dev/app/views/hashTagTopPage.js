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
			
			
			//name, and children to infinite depth for the d3 partition layout
			var wheelTree = { 
				"name": "flare",
				"children": [hashTags]
			};

  
			///////////
			// Sort the data array, each data set will be added to the page by D3 in sequential order.
			/// TODO
			
			//////////
			///Main Wheel sizing
			var width = 600;
			var height = 600;
			var radius = Math.min(width, height) / 2;
			var color = d3.scale.category20c();
			
			/////////
			// Add them to the page, and apply dynamic styles using D3.
			//var svg = d3.select(".topWheelSvg g") //g = a group SVG shapes
//			
//			var partition = d3.layout.partition()
//				.sort(null)
//				.size([2 * Math.PI, radius * radius])
//				.value(function(d) { return 1; });
//			
//			var arc = d3.svg.arc()
//				.startAngle(function(d) { return d.x; })
//				.endAngle(function(d) { return d.x + d.dx; })
//				.innerRadius(function(d) { return Math.sqrt(d.y); })
//				.outerRadius(function(d) { return Math.sqrt(d.y + d.dy); });
//			
//			var path = svg.datum(hashTags).selectAll("path")
//				.data(partition.nodes)
//				.enter()
//					.append("path")
//						.attr("display", function(d) { return 'none'; }) // hide inner ring
//						.attr("d", arc)
//						.style("stroke", "#fff")
//						.style("fill", function(d) { return color(d.tag); })
//						.style("fill-rule", "evenodd")
//						.each(stash);
//							
//							
//			path.data(partition.value('count').nodes)
//				.transition()
//				.duration(1500)
//				.attrTween("d", arcTween);
//				
//				
//			// Stash the old values for transition.
//			function stash(d) {
//				d.x0 = d.x;
//				d.dx0 = d.dx;
//			}
//			
//			// Interpolate the arcs in data space.
//			function arcTween(a) {
//				var i = d3.interpolate({x: a.x0, dx: a.dx0}, a);
//				return function(t) {
//					var b = i(t);
//					a.x0 = b.x;
//					a.dx0 = b.dx;
//					return arc(b);
//				};
//			}


	
			//Strait from example
			var width = 960,
				height = 700,
				radius = Math.min(width, height)*.5,
				color = d3.scale.category20c();
			
			var svg = d3.select(".topWheel").append("svg")
				.attr("width", width)
				.attr("height", height)
			  .append("g")
				.attr("transform", "translate(" + width*.5 + "," + height*.5 + ")");
			
			var partition = d3.layout.partition()
				.sort(null)
				.size([2 * Math.PI, radius * radius])
				.value(function(d) { return d.count; });
			
			var arc = d3.svg.arc()
				.startAngle(function(d) { return d.x; })
				.endAngle(function(d) { return d.x + d.dx; })
				.innerRadius(function(d) { return Math.sqrt(d.y); })
				.outerRadius(function(d) { return Math.sqrt(d.y + d.dy); });
			
			//d3.json('views/sampleData.json', function(error, root) {
			  var path = svg.datum(hashTags).selectAll("path")
				  .data(partition.nodes)
				.enter().append("path")
				  .attr("display", function(d) { return d.depth ? null : "none"; }) // hide inner ring
				  .attr("d", arc)
				  .style("stroke", "#fff")
				  .style("fill", function(d) { return color(d.name); })
				  .style("fill-rule", "evenodd")
				  .each(stash);
			
//			  d3.selectAll("input").on("change", function change() {
//				var value = this.value === "count"
//					? function() { return 1; }
//					: function(d) { return d.size; };
//			
//				path
//					.data(partition.value(value).nodes)
//				  .transition()
//					.duration(1500)
//					.attrTween("d", arcTween);
//			  });
			//});
			
			// Stash the old values for transition.
			function stash(d) {
			  d.x0 = d.x;
			  d.dx0 = d.dx;
			}
			
			// Interpolate the arcs in data space.
			function arcTween(a) {
			  var i = d3.interpolate({x: a.x0, dx: a.dx0}, a);
			  return function(t) {
				var b = i(t);
				a.x0 = b.x;
				a.dx0 = b.dx;
				return arc(b);
			  };
			}

			d3.select(self.frameElement).style("height", height + "px");

		},
		
		bind: function(app){	
			
		}
		
	});
	
	return hashTagTopPage;
	
});