import SwaggerParser from "@apidevtools/swagger-parser";
import { validateEvent, validateReminderEvent } from "../src/event";
SwaggerParser.validate("openapi.yaml")
  .then(() => {
    if (!validateEvent || !validateReminderEvent) throw new Error("Schema not compiled");
    console.log("Health OpenAPI valid; event schemas compiled");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
