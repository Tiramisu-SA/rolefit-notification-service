import SwaggerParser from "@apidevtools/swagger-parser";
import { validateEvent } from "../src/event";
SwaggerParser.validate("openapi.yaml")
  .then(() => {
    if (!validateEvent) throw new Error("Schema not compiled");
    console.log("Health OpenAPI valid; event schema compiled");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
