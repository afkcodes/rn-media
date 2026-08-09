#include "TestRunner.h"

#include <cstring>

int main(int argc, char** argv) {
  const char* filter = argc > 1 ? argv[1] : nullptr;

  int passed = 0;
  int failed = 0;
  for (const auto& test : rnmedia::testing::registry()) {
    if (filter != nullptr && std::strstr(test.suite, filter) == nullptr) {
      continue;
    }
    try {
      test.body();
      std::printf("  PASS  %s.%s\n", test.suite, test.name);
      ++passed;
    } catch (const rnmedia::testing::AssertionFailure& failure) {
      std::printf("  FAIL  %s.%s\n        %s\n", test.suite, test.name, failure.what());
      ++failed;
    } catch (const std::exception& error) {
      std::printf("  FAIL  %s.%s\n        unexpected exception: %s\n", test.suite, test.name, error.what());
      ++failed;
    }
  }

  std::printf("\n%d passed, %d failed\n", passed, failed);
  return failed == 0 ? 0 : 1;
}
