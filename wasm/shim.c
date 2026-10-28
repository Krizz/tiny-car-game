// Flat, JS-friendly slice of Box3D for cargame (original game in the browser).
//
// What the game needs from Box3D:
//   - the track: static triangle meshes (original game's .ncp collision, converted)
//   - cars: dynamic convex hulls (the car's .hul points) with mass, centre of
//     mass and inertia taken from Parameters.txt
//   - raycasts against the track for the wheel suspension (car.ts owns the
//     tyre model and applies its forces as impulses)
//
// Derived from gta/wasm/shim.c, but indexed: any number of cars (the local
// one, and every remote player's car as a body pulled towards its reported
// pose, so bumps between cars resolve locally).
//
// Built single-threaded with emscripten; the JS side (src/physics.ts) talks
// to these functions through HEAPF32 + direct calls.

#include <box3d/box3d.h>
#include <box3d/collision.h>
#include <box3d/math_functions.h>
#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>

#define MAX_MESHES 64
#define MAX_CARS 64 // cars and balls share the slots
#define SCRATCH_FLOATS 400000 // up to ~44k triangles per mesh call

#define CAT_TRACK 0x0001u
#define CAT_CAR 0x0002u    // this browser's own car
#define CAT_REMOTE 0x0004u // other players' cars: they hit our car, never each other
#define CAT_BALL 0x0008u   // weapon balls (ball bearing): hit everything

static b3WorldId world;
static bool worldAlive = false;
static bool treeDirty = false;

static b3BodyId meshBodies[MAX_MESHES];
static b3MeshData* meshData[MAX_MESHES];
static int meshCount = 0;

static b3BodyId cars[MAX_CARS];
static bool carAlive[MAX_CARS];

static float scratch[SCRATCH_FLOATS];
static float out[32];

EMSCRIPTEN_KEEPALIVE
float* w_scratch( void )
{
	return scratch;
}

EMSCRIPTEN_KEEPALIVE
float* w_out( void )
{
	return out;
}

EMSCRIPTEN_KEEPALIVE
void w_init( float gx, float gy, float gz )
{
	if ( worldAlive )
	{
		b3DestroyWorld( world );
		for ( int i = 0; i < meshCount; i++ )
			b3DestroyMesh( meshData[i] );
	}
	b3WorldDef def = b3DefaultWorldDef();
	def.gravity = ( b3Vec3 ){ gx, gy, gz };
	world = b3CreateWorld( &def );
	worldAlive = true;
	b3World_EnableContinuous( world, true );
	meshCount = 0;
	for ( int i = 0; i < MAX_CARS; i++ )
		carAlive[i] = false;
}

// One static mesh body from `triCount` triangles in scratch ([x,y,z] * 3 each).
// `materials` (if non-zero) follows the vertices in scratch as one float per
// triangle: the original game surface id, handed back by raycasts.
EMSCRIPTEN_KEEPALIVE
int w_add_mesh( int triCount, float friction, int withMaterials )
{
	if ( !worldAlive || triCount <= 0 || meshCount >= MAX_MESHES ) return -1;
	int maxTris = SCRATCH_FLOATS / 10;
	if ( triCount > maxTris ) triCount = maxTris;

	int vertexCount = triCount * 3;
	b3Vec3* vertices = malloc( (size_t)vertexCount * sizeof( b3Vec3 ) );
	int32_t* indices = malloc( (size_t)vertexCount * sizeof( int32_t ) );
	uint8_t* triMat = withMaterials ? malloc( (size_t)triCount ) : NULL;
	for ( int i = 0; i < vertexCount; ++i )
	{
		vertices[i] = ( b3Vec3 ){ scratch[i * 3], scratch[i * 3 + 1], scratch[i * 3 + 2] };
		indices[i] = i;
	}

	// Surface materials: one per distinct id (original game has < 32).
	b3SurfaceMaterial mats[32];
	int matCount = 0;
	if ( withMaterials )
	{
		for ( int m = 0; m < 32; m++ )
		{
			mats[m] = b3DefaultSurfaceMaterial();
			mats[m].friction = friction;
			mats[m].userMaterialId = (uint64_t)m;
		}
		matCount = 32;
		for ( int t = 0; t < triCount; t++ )
		{
			int id = (int)scratch[vertexCount * 3 + t];
			triMat[t] = (uint8_t)( id < 0 ? 0 : ( id > 31 ? 31 : id ) );
		}
	}

	b3MeshDef md = { 0 };
	md.vertices = vertices;
	md.indices = indices;
	md.vertexCount = vertexCount;
	md.triangleCount = triCount;
	md.materialIndices = triMat;
	md.weldVertices = true;
	md.weldTolerance = 0.001f;
	md.identifyEdges = true;
	md.useMedianSplit = true;
	b3MeshData* mesh = b3CreateMesh( &md, NULL, 0 );
	free( vertices );
	free( indices );
	free( triMat );
	if ( mesh == NULL ) return -1;

	b3BodyDef bd = b3DefaultBodyDef();
	bd.type = b3_staticBody;
	b3BodyId body = b3CreateBody( world, &bd );
	b3ShapeDef sd = b3DefaultShapeDef();
	sd.filter.categoryBits = CAT_TRACK;
	sd.filter.maskBits = 0xFFFFFFFFu;
	sd.baseMaterial.friction = friction;
	sd.baseMaterial.restitution = 0.0f;
	sd.materials = withMaterials ? mats : NULL;
	sd.materialCount = matCount;
	b3CreateMeshShape( body, &sd, mesh, ( b3Vec3 ){ 1.0f, 1.0f, 1.0f } );
	meshBodies[meshCount] = body;
	meshData[meshCount] = mesh;
	treeDirty = true;
	return meshCount++;
}

static void flush( void )
{
	if ( worldAlive && treeDirty )
	{
		b3World_RebuildStaticTree( world );
		treeDirty = false;
	}
}

EMSCRIPTEN_KEEPALIVE
void w_step( float dt, int subSteps )
{
	if ( !worldAlive ) return;
	flush();
	b3World_Step( world, dt, subSteps );
}

// Closest hit against the track only (wheels don't stand on other cars).
// out: [dist, px, py, pz, nx, ny, nz, material] ; dist < 0 = miss.
EMSCRIPTEN_KEEPALIVE
float* w_raycast( float ox, float oy, float oz, float dx, float dy, float dz, float maxLen )
{
	out[0] = -1.0f;
	if ( !worldAlive ) return out;
	flush();
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.categoryBits = 0xFFFFFFFFu;
	filter.maskBits = CAT_TRACK;
	b3RayResult r = b3World_CastRayClosest( world, ( b3Pos ){ ox, oy, oz },
											( b3Vec3 ){ dx * maxLen, dy * maxLen, dz * maxLen }, filter );
	if ( r.hit )
	{
		out[0] = r.fraction * maxLen;
		out[1] = (float)r.point.x;
		out[2] = (float)r.point.y;
		out[3] = (float)r.point.z;
		out[4] = r.normal.x;
		out[5] = r.normal.y;
		out[6] = r.normal.z;
		out[7] = (float)r.userMaterialId;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

// Hull points ([x,y,z] * pointCount, body frame, metres) are in scratch.
// Mass properties are given explicitly (from Parameters.txt), not from density.
EMSCRIPTEN_KEEPALIVE
int car_create( int pointCount, float mass, float cx, float cy, float cz, float ixx, float iyy, float izz,
				float x, float y, float z, float qx, float qy, float qz, float qw, float friction, int remote,
				int wheelCount )
{
	if ( !worldAlive ) return -1;
	int id = -1;
	for ( int i = 0; i < MAX_CARS; i++ )
		if ( !carAlive[i] )
		{
			id = i;
			break;
		}
	if ( id < 0 ) return -1;

	b3BodyDef bd = b3DefaultBodyDef();
	bd.type = b3_dynamicBody;
	bd.position = ( b3Pos ){ x, y, z };
	bd.rotation = ( b3Quat ){ { qx, qy, qz }, qw };
	bd.isBullet = true;
	bd.enableSleep = false; // a resting car that sleeps ignores SetTransform: rescued cars hung in mid-air
	b3BodyId body = b3CreateBody( world, &bd );

	b3ShapeDef sd = b3DefaultShapeDef();
	sd.density = 1.0f;
	sd.updateBodyMass = false; // mass data is set explicitly below
	// remote cars already collided with each other in their owners' browsers:
	// colliding them again here only makes them fight their targets (jitter)
	sd.filter.categoryBits = remote ? CAT_REMOTE : CAT_CAR;
	sd.filter.maskBits = remote ? ( CAT_TRACK | CAT_CAR | CAT_BALL ) : ( CAT_TRACK | CAT_CAR | CAT_REMOTE | CAT_BALL );
	sd.baseMaterial.friction = friction; // the tyre model owns grip; the body slides
	sd.baseMaterial.restitution = 0.0f;	 // box3d mixes max(A,B): any bounce here bounces everything

	b3Vec3* pts = malloc( (size_t)pointCount * sizeof( b3Vec3 ) );
	for ( int i = 0; i < pointCount; i++ )
		pts[i] = ( b3Vec3 ){ scratch[i * 3], scratch[i * 3 + 1], scratch[i * 3 + 2] };
	b3HullData* hull = b3CreateHull( pts, pointCount, 64 );
	free( pts );
	if ( hull != NULL )
	{
		b3CreateHullShape( body, &sd, hull );
		b3DestroyHull( hull );
	}
	else
	{
		b3BoxHull box = b3MakeBoxHull( 0.2f, 0.1f, 0.4f );
		b3CreateHullShape( body, &sd, &box.base );
	}

	// Tyres: spheres (x, y, z, r in scratch after the hull points), as in original game.
	// They stop wheels going into walls, and act as bump stops on the floor.
	for ( int w = 0; w < wheelCount; w++ )
	{
		const float* f = scratch + pointCount * 3 + w * 4;
		b3Sphere tyre = { { f[0], f[1], f[2] }, f[3] };
		b3CreateSphereShape( body, &sd, &tyre );
	}

	b3MassData md;
	md.mass = mass;
	md.center = ( b3Vec3 ){ cx, cy, cz };
	md.inertia = ( b3Matrix3 ){ { ixx, 0, 0 }, { 0, iyy, 0 }, { 0, 0, izz } };
	b3Body_SetMassData( body, md );

	cars[id] = body;
	carAlive[id] = true;
	return id;
}

// A dynamic sphere (weapon ball). Uses a car slot: car_state / car_set_velocity /
// car_destroy work on it too.
EMSCRIPTEN_KEEPALIVE
int ball_create( float radius, float mass, float x, float y, float z, float vx, float vy, float vz, float friction,
				 float restitution )
{
	if ( !worldAlive ) return -1;
	int id = -1;
	for ( int i = 0; i < MAX_CARS; i++ )
		if ( !carAlive[i] )
		{
			id = i;
			break;
		}
	if ( id < 0 ) return -1;
	b3BodyDef bd = b3DefaultBodyDef();
	bd.type = b3_dynamicBody;
	bd.position = ( b3Pos ){ x, y, z };
	bd.linearVelocity = ( b3Vec3 ){ vx, vy, vz };
	bd.isBullet = true;
	bd.enableSleep = false;
	b3BodyId body = b3CreateBody( world, &bd );
	b3ShapeDef sd = b3DefaultShapeDef();
	float vol = 4.18879f * radius * radius * radius;
	sd.density = mass / vol;
	sd.filter.categoryBits = CAT_BALL;
	sd.filter.maskBits = CAT_TRACK | CAT_CAR | CAT_REMOTE | CAT_BALL;
	sd.baseMaterial.friction = friction;
	sd.baseMaterial.restitution = restitution;
	sd.baseMaterial.rollingResistance = 0.02f;
	b3Sphere sphere = { { 0.0f, 0.0f, 0.0f }, radius };
	b3CreateSphereShape( body, &sd, &sphere );
	cars[id] = body;
	carAlive[id] = true;
	return id;
}

// A kinematic body of `boxCount` boxes ([cx, cy, cz, hx, hy, hz] each in scratch, body frame):
// a moving level object (the Toy World 2 train). Counts as track: it pushes cars and balls,
// nothing pushes it, and the wheels' raycasts land on it. Uses a car slot: car_set_pose /
// car_set_velocity move it, car_destroy removes it.
EMSCRIPTEN_KEEPALIVE
int kin_create( int boxCount, float x, float y, float z, float qx, float qy, float qz, float qw, float friction )
{
	if ( !worldAlive ) return -1;
	int id = -1;
	for ( int i = 0; i < MAX_CARS; i++ )
		if ( !carAlive[i] )
		{
			id = i;
			break;
		}
	if ( id < 0 ) return -1;
	b3BodyDef bd = b3DefaultBodyDef();
	bd.type = b3_kinematicBody;
	bd.position = ( b3Pos ){ x, y, z };
	bd.rotation = ( b3Quat ){ { qx, qy, qz }, qw };
	bd.enableSleep = false;
	b3BodyId body = b3CreateBody( world, &bd );
	b3ShapeDef sd = b3DefaultShapeDef();
	sd.filter.categoryBits = CAT_TRACK;
	sd.filter.maskBits = 0xFFFFFFFFu;
	sd.baseMaterial.friction = friction;
	sd.baseMaterial.restitution = 0.0f;
	for ( int b = 0; b < boxCount; b++ )
	{
		const float* f = scratch + b * 6;
		b3BoxHull box = b3MakeOffsetBoxHull( f[3], f[4], f[5], ( b3Vec3 ){ f[0], f[1], f[2] } );
		b3CreateHullShape( body, &sd, &box.base );
	}
	cars[id] = body;
	carAlive[id] = true;
	return id;
}

EMSCRIPTEN_KEEPALIVE
void car_destroy( int id )
{
	if ( id < 0 || id >= MAX_CARS || !carAlive[id] ) return;
	b3DestroyBody( cars[id] );
	carAlive[id] = false;
}

#define CAR_OK( id ) ( id >= 0 && id < MAX_CARS && carAlive[id] )

EMSCRIPTEN_KEEPALIVE
void car_impulse_at( int id, float ix, float iy, float iz, float px, float py, float pz )
{
	if ( CAR_OK( id ) ) b3Body_ApplyLinearImpulse( cars[id], ( b3Vec3 ){ ix, iy, iz }, ( b3Pos ){ px, py, pz }, true );
}

EMSCRIPTEN_KEEPALIVE
void car_angular_impulse( int id, float ix, float iy, float iz )
{
	if ( CAR_OK( id ) ) b3Body_ApplyAngularImpulse( cars[id], ( b3Vec3 ){ ix, iy, iz }, true );
}

// out: [vx, vy, vz] of the body point at world p
EMSCRIPTEN_KEEPALIVE
float* car_point_velocity( int id, float px, float py, float pz )
{
	out[0] = out[1] = out[2] = 0.0f;
	if ( CAR_OK( id ) )
	{
		b3Vec3 v = b3Body_GetWorldPointVelocity( cars[id], ( b3Pos ){ px, py, pz } );
		out[0] = v.x;
		out[1] = v.y;
		out[2] = v.z;
	}
	return out;
}

// out: [px,py,pz, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz, comx,comy,comz]
EMSCRIPTEN_KEEPALIVE
float* car_state( int id )
{
	if ( !CAR_OK( id ) ) return out;
	b3BodyId b = cars[id];
	b3Pos p = b3Body_GetPosition( b );
	b3Quat q = b3Body_GetRotation( b );
	b3Vec3 v = b3Body_GetLinearVelocity( b );
	b3Vec3 w = b3Body_GetAngularVelocity( b );
	b3Pos c = b3Body_GetWorldCenter( b );
	out[0] = (float)p.x;
	out[1] = (float)p.y;
	out[2] = (float)p.z;
	out[3] = q.v.x;
	out[4] = q.v.y;
	out[5] = q.v.z;
	out[6] = q.s;
	out[7] = v.x;
	out[8] = v.y;
	out[9] = v.z;
	out[10] = w.x;
	out[11] = w.y;
	out[12] = w.z;
	out[13] = (float)c.x;
	out[14] = (float)c.y;
	out[15] = (float)c.z;
	return out;
}

// World inverse inertia (row-major 3x3) — for effective-mass tyre impulses.
EMSCRIPTEN_KEEPALIVE
float* car_inv_inertia( int id )
{
	if ( !CAR_OK( id ) ) return out;
	b3Matrix3 m = b3Body_GetWorldInverseRotationalInertia( cars[id] );
	out[0] = m.cx.x;
	out[1] = m.cy.x;
	out[2] = m.cz.x;
	out[3] = m.cx.y;
	out[4] = m.cy.y;
	out[5] = m.cz.y;
	out[6] = m.cx.z;
	out[7] = m.cy.z;
	out[8] = m.cz.z;
	return out;
}

EMSCRIPTEN_KEEPALIVE
void car_set_pose( int id, float x, float y, float z, float qx, float qy, float qz, float qw )
{
	if ( CAR_OK( id ) ) b3Body_SetTransform( cars[id], ( b3Pos ){ x, y, z }, ( b3Quat ){ { qx, qy, qz }, qw } );
}

EMSCRIPTEN_KEEPALIVE
void car_set_velocity( int id, float vx, float vy, float vz, float wx, float wy, float wz )
{
	if ( !CAR_OK( id ) ) return;
	b3Body_SetLinearVelocity( cars[id], ( b3Vec3 ){ vx, vy, vz } );
	b3Body_SetAngularVelocity( cars[id], ( b3Vec3 ){ wx, wy, wz } );
}

EMSCRIPTEN_KEEPALIVE
void car_set_damping( int id, float linear, float angular )
{
	if ( !CAR_OK( id ) ) return;
	b3Body_SetLinearDamping( cars[id], linear );
	b3Body_SetAngularDamping( cars[id], angular );
}
