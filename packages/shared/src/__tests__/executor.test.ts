import { isAllowedTool } from "../sandbox/executor.js";

describe("Sandbox Executor", () => {
  describe("isAllowedTool", () => {
    it("should allow standard tools", () => {
      expect(isAllowedTool("code_interpreter")).toBe(true);
      expect(isAllowedTool("file_read")).toBe(true);
      expect(isAllowedTool("file_write")).toBe(true);
      expect(isAllowedTool("database_query")).toBe(true);
    });

    it("should block dangerous tools", () => {
      expect(isAllowedTool("rm -rf /")).toBe(false);
      expect(isAllowedTool("shell")).toBe(false);
      expect(isAllowedTool("exec")).toBe(false);
      expect(isAllowedTool("docker_exec")).toBe(false);
    });

    it("should block empty or missing tools", () => {
      expect(isAllowedTool("")).toBe(false);
      expect(isAllowedTool(" ")).toBe(false);
    });
  });
});
