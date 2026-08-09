project(RnMediaPlayer)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME RnMediaPlayer)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# Enable Raw Props parsing in react-native (for Nitro Views)
add_compile_options(-DRN_SERIALIZABLE_STATE=1)

# Define C++ library and add all sources
add_library(${PACKAGE_NAME} SHARED
	src/main/cpp/cpp-adapter.cpp
	../cpp/MpvClient.cpp
	../cpp/HybridMpvClient.cpp
)

# Add Nitrogen specs :)
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/RnMediaPlayer+autolinking.cmake)

# Set up local includes
include_directories(
        "src/main/cpp"
        "../cpp"
        "../cpp/third_party/mpv/include"           # <-- vendored mpv/client.h (ISC)
)

# Prebuilt libmpv (audio flavour). LIBMPV_JNILIBS_DIR is passed in from
# android/build.gradle and points at the output of the `prepareLibmpv` task,
# which downloads + checksum-verifies + extracts one libmpv.so per ABI.
if (NOT DEFINED LIBMPV_JNILIBS_DIR)
  message(FATAL_ERROR "LIBMPV_JNILIBS_DIR was not set — configure via Gradle, not standalone CMake.")
endif()

set(LIBMPV_SO "${LIBMPV_JNILIBS_DIR}/${ANDROID_ABI}/libmpv.so")
add_library(mpv SHARED IMPORTED)
set_target_properties(mpv PROPERTIES IMPORTED_LOCATION "${LIBMPV_SO}")

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android                                   # <-- Android core
        mpv                                       # <-- prebuilt libmpv, becomes DT_NEEDED
)
