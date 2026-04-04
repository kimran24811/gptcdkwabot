import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "../admin.js";
import platformRouter from "../platform.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use("/platform", platformRouter);

export default router;
