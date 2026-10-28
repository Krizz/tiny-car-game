cmake_minimum_required(VERSION 3.22)
project(box3d_cargame_wasm LANGUAGES C CXX)

# box3d as a subproject so its emscripten pthread flags stay with it:
# single-threaded wasm, no SharedArrayBuffer / COOP+COEP (same as gta, physics).
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../box3d box3d)

add_executable(box3d_cargame shim.c)
target_link_libraries(box3d_cargame PRIVATE box3d::box3d)
set_target_properties(box3d_cargame PROPERTIES OUTPUT_NAME "box3d")

target_link_options(box3d_cargame PRIVATE
	"-sMODULARIZE=1"
	"-sEXPORT_ES6=1"
	"-sEXPORT_NAME=createBox3d"
	"-sALLOW_MEMORY_GROWTH=1"
	"-sENVIRONMENT=web,node"
	"-sEXPORTED_RUNTIME_METHODS=HEAPF32"
	"-sNO_EXIT_RUNTIME=1"
	"-O3"
)
