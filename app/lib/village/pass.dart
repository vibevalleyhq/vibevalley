// Which pass the village is drawing (game.dart renderTree): the painted world, its normal maps, what shines over the
// lit world (added, or drawn over it), the marks over it as painted, or the plants in front of the camera. Components
// draw what is theirs.

enum RenderPass { color, normals, glows, marks, near }

RenderPass renderPass = RenderPass.color;
