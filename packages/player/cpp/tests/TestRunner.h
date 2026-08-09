#pragma once

///
/// Minimal assert-based test harness for the host-compiled C++ tests.
///
/// Deliberately dependency-free: the units under test (`EventBatch`,
/// `ClientState`) are pure std, so pulling in a test framework would add the
/// only third-party dependency in the whole test build for the sake of nicer
/// output. `TEST(...)` self-registers; `main()` runs everything and returns
/// non-zero on the first failing assertion in each test.
///

#include <cstdio>
#include <exception>
#include <functional>
#include <string>
#include <vector>

namespace rnmedia::testing {

struct TestCase {
  const char* suite;
  const char* name;
  std::function<void()> body;
};

inline std::vector<TestCase>& registry() {
  static std::vector<TestCase> tests;
  return tests;
}

struct Registrar {
  Registrar(const char* suite, const char* name, std::function<void()> body) {
    registry().push_back(TestCase{suite, name, std::move(body)});
  }
};

/// Thrown by CHECK on failure; caught by the runner so one bad test does not
/// abort the rest of the suite.
struct AssertionFailure final : std::exception {
  std::string message;
  explicit AssertionFailure(std::string text) : message(std::move(text)) {}
  const char* what() const noexcept override {
    return message.c_str();
  }
};

inline void fail(const char* file, int line, const std::string& expression, const std::string& detail) {
  std::string text = std::string(file) + ":" + std::to_string(line) + ": " + expression;
  if (!detail.empty()) {
    text += "  (" + detail + ")";
  }
  throw AssertionFailure(text);
}

} // namespace rnmedia::testing

#define RNMEDIA_CONCAT_INNER(a, b) a##b
#define RNMEDIA_CONCAT(a, b) RNMEDIA_CONCAT_INNER(a, b)

#define TEST(suite, name)                                                                                              \
  static void RNMEDIA_CONCAT(suite##_##name##_body, __LINE__)();                                                       \
  static const ::rnmedia::testing::Registrar RNMEDIA_CONCAT(suite##_##name##_reg, __LINE__)(                           \
      #suite, #name, &RNMEDIA_CONCAT(suite##_##name##_body, __LINE__));                                                \
  static void RNMEDIA_CONCAT(suite##_##name##_body, __LINE__)()

#define CHECK(expr)                                                                                                    \
  do {                                                                                                                 \
    if (!(expr)) {                                                                                                     \
      ::rnmedia::testing::fail(__FILE__, __LINE__, "CHECK(" #expr ")", "");                                            \
    }                                                                                                                  \
  } while (false)

#define CHECK_EQ(actual, expected)                                                                                     \
  do {                                                                                                                 \
    const auto& rnmediaActual = (actual);                                                                              \
    const auto& rnmediaExpected = (expected);                                                                          \
    if (!(rnmediaActual == rnmediaExpected)) {                                                                         \
      ::rnmedia::testing::fail(__FILE__, __LINE__, "CHECK_EQ(" #actual ", " #expected ")", "values differ");            \
    }                                                                                                                  \
  } while (false)

#define CHECK_THROWS(expr, ExceptionType)                                                                              \
  do {                                                                                                                 \
    bool rnmediaThrew = false;                                                                                         \
    try {                                                                                                              \
      (void)(expr);                                                                                                    \
    } catch (const ExceptionType&) {                                                                                   \
      rnmediaThrew = true;                                                                                             \
    } catch (...) {                                                                                                    \
      ::rnmedia::testing::fail(__FILE__, __LINE__, "CHECK_THROWS(" #expr ", " #ExceptionType ")",                       \
                               "threw a different exception type");                                                    \
    }                                                                                                                  \
    if (!rnmediaThrew) {                                                                                               \
      ::rnmedia::testing::fail(__FILE__, __LINE__, "CHECK_THROWS(" #expr ", " #ExceptionType ")", "did not throw");     \
    }                                                                                                                  \
  } while (false)
