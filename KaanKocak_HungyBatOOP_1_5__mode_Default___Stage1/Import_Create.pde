//BatGameplay
Gif BatIdle;
Gif BatIdle_Happy;
Gif BatDive_Happy;
Gif BatDive_Sad;

//Encounters
Gif WormIdle;
Gif SpiderIdle;
Gif SpiderAttack;
Gif BugIdle;
Gif BugAttack;
Gif Death;
Gif BatSlide_L;
Gif BatSlide_R;
Gif BatDeath;

//BatIntro
Gif BatSleeping;
Gif BatAwake;
Gif BatIntroDive;

SoundFile SoundMusic, SoundBug, SoundDeath, SoundHealthUp, SoundBatDamage, SoundSpider, SoundRock, SoundWorm;
String audioName1 = "HungryBat_Music.wav";
String audioName2 = "Bug.wav";
String audioName3 = "Death.wav";
String audioName4 = "HealthUp.wav";
String audioName5 = "BatDamage.wav";
String audioName6 = "Spider.wav";
String audioName7 = "Rock.wav";
String audioName8 = "Worm.wav";
String path1, path2, path3, path4, path5, path6, path7, path8;

PImage Shadow, Ground, BatShadow, Rock, Cone, Heart, Frame, Prey, Intro1, Intro2, BatAwaken;
PImage UIFrame, UIFrame2, Mouse, Keys, BatIntroDiving, BatIntroDiving2, BatDeathPose, WormAttack;
PFont font;

void CreateImported() {

  // create Font 
  font = createFont("Mystery Font.ttf", 40);
  textFont(font);

  //Bat//
  //Idle
  BatIdle = new Gif(this, "BatIdle2.gif");
  BatIdle.loop();

  //IdleHappy
  BatIdle_Happy = new Gif(this, "BatIdle_Happy.gif");
  BatIdle_Happy.loop();

  //DiveHappy
  BatDive_Happy = new Gif(this, "BatDive_Happy5.gif");
  BatDive_Happy.ignoreRepeat();

  //DiveSad
  BatDive_Sad = new Gif(this, "BatIdle_Sad.gif");
  BatDive_Sad.loop();

  //Slide Left
  BatSlide_L = new Gif(this, "BatSlide_L.gif");
  BatSlide_L.loop();

  //Slide Right
  BatSlide_R = new Gif(this, "BatSlide_R.gif");
  BatSlide_R.loop();

  //BatDeath
  BatDeath = new Gif(this, "BatDeath.gif");
  BatDeath.loop();

  //BatDeath Pose
  BatDeathPose = loadImage("death5.png");


  //Bat Intro//
  //BatAwaken
  BatAwaken = loadImage("BatAwaken.png");

  //BatAwake
  BatAwake = new Gif(this, "BatAwake.gif");
  BatAwake.ignoreRepeat();

  //BatSleeping
  BatSleeping = new Gif(this, "BatSleeping.gif");
  BatSleeping.loop();

  //BatIntroDive
  BatIntroDive = new Gif(this, "BatIntroDive.gif");
  BatIntroDive.ignoreRepeat();

  //BatIntroDiving
  BatIntroDiving = loadImage("BatIntroDiving.png"); 

  //BatIntroDiving2
  BatIntroDiving2 = loadImage("BatDiveIntro.png"); 


  //Encounters//
  // create Worm 
  WormIdle = new Gif(this, "WormIdle.gif");
  WormIdle.loop();

  WormAttack = loadImage("WormAttackPose.png");

  // create Death 
  Death = new Gif(this, "Death.gif");
  Death.loop();

  // create Spider 
  SpiderIdle = new Gif(this, "SpiderIdle.gif");
  SpiderIdle.loop();

  SpiderAttack = new Gif(this, "SpiderAttack2.gif");
  SpiderAttack.ignoreRepeat();

  // create Bug
  BugIdle = new Gif(this, "BugIdle.gif");
  BugIdle.loop();

  // create Bug Attack
  BugAttack = new Gif(this, "BugAttack2.gif");
  BugAttack.ignoreRepeat();

  //create Shadow
  Shadow = loadImage("Shadow.png");

  //create PlayerShadow
  BatShadow = loadImage("BatShadow.png");

  //create Obsticles
  Cone = loadImage("Cone.png");
  Rock = loadImage("Rock.png");

  //create Ground
  Ground = loadImage("Ground2.png");  //Create image

  //create Heart
  Heart = loadImage("Heart.png");

  //create Frame
  Frame = loadImage("Frame.png");

  //create Prey Icon
  Prey = loadImage("Preys.png");

  //create UIFrame
  UIFrame = loadImage("UIFrame.png");

  //create UIFrame2
  UIFrame2 = loadImage("UIFrame2.png");

  //Intro1
  Intro1 = loadImage("Intro1.png");

  //Intro2
  Intro2 = loadImage("Intro2.png");

  //Mouse
  Mouse = loadImage("Mouse.png");
  //Keys
  Keys = loadImage("Keys.png");

  //Ground
  Ground = loadImage("Ground2.png");  //Create image

  //Sounds//
  path1 = sketchPath(audioName1);
  path2 = sketchPath(audioName2);
  path3 = sketchPath(audioName3);
  path4 = sketchPath(audioName4);
  path5 = sketchPath(audioName5);
  path6 = sketchPath(audioName6);
  path7 = sketchPath(audioName7);
  path8 = sketchPath(audioName8);

  SoundMusic = new SoundFile(this, path1);  
  SoundBug = new SoundFile(this, path2);  
  SoundDeath = new SoundFile(this, path3);    
  SoundHealthUp = new SoundFile(this, path4);
  SoundBatDamage = new SoundFile(this, path5);
  SoundSpider = new SoundFile(this, path6);
  SoundRock = new SoundFile(this, path7);
    SoundWorm = new SoundFile(this, path8);
}
