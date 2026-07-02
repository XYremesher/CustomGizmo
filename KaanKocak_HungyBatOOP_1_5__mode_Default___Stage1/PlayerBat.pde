class Player {
  boolean Control;
  boolean P2Slide=true;

  int RankPlayer=1;
  float PlayerX;
  float PlayerY;

  float easing = 0.1;  //easing Mouse//

  float r;  //collider radius

  int PreyCounted; //on UI
  int Health;
  int Anim=0;    //Animation switcher

  //Counters and Switches//
  int CountHealth;
  int CountDiveSad;
  int CountDiveHappy;
  int CountIdleHappy;
  float CountIntro=0;
  float SlideIntro=0; 
  int CountIntroDive=0;
  int ShadowMover=3;
  int ShadowSwitch;
  int ColorFade=0;
  int StartController=0;
  int CountBatDeath=0;
  int CountLevelUpSwitch=0;
  int CountLevelUp;

  //Player2 controller thing
  float targetX_P2=width/2;

  int Players=1;


  Player() {

    PlayerY=height/2+150;
    PlayerX=width/2;
    r= 65;

    ShadowMover=450;
    Anim=-1;    //Sleeping

    PreyCounted=0;

    Health=99;
  }


  //Display Bat//

  void DispShadow() {
    float X=PlayerX;
    float Y=PlayerY;
    int ImgPos=100;
    image(BatShadow, X, Y-ImgPos+ShadowMover);
  }

  void Display() {

    float X=PlayerX;
    float Y=PlayerY;

    //  Collider circle  //
    noFill();
    stroke(2);
    //circle(X, Y, r);  

    line(mouseX, mouseY, pmouseX, pmouseY);  //Draw a line between early mouse pos.
    //The Bat//

    int ImgPos=100;
    switch(Anim) {

    case -6:        //BatIntroDiving2   Pose
      image(BatIntroDiving2, X, Y-ImgPos);
      break;
    case -5:       //BatIntroDiving    Pose
      image(BatIntroDiving, X, Y-ImgPos);
      break;
    case -4:      //BatIntroRollDown
      BatIntroDive.play();
      image(BatIntroDive, X, Y-ImgPos);
      break;
    case -3:      //BatAwaken   Pose
      image(BatAwaken, X, Y-ImgPos);
      break;      
    case -2:      //BatAwake
      BatAwake.play();
      image(BatAwake, X, Y-ImgPos);
      break;
    case -1:      //BatSleeping
      BatSleeping.play();
      image(BatSleeping, X, Y-ImgPos);
      break;
    case 0:       //Idle

        BatSlide_R.pause();
                BatSlide_L.pause();
                      if (RankPlayer<3) {
        BatIdle.play();
        image(BatIdle, X, Y-ImgPos);
      } else
        Anim=5;
                
      break;
    case 1:      //Dive_Happy
      BatDive_Happy.play();
      image(BatDive_Happy, X, Y-ImgPos);
      CountDiveHappy++;
      if (CountDiveHappy==10) {
        Anim=5;
      }
      break;
    case 2:      //Dive_Sad
      BatDive_Sad.play();
      image(BatDive_Sad, X, Y-ImgPos);
      CountDiveSad++;
      if (CountDiveSad==35) {
        Anim=0;
      }
      break;
    case 3:      //BatSlide_R  
              BatSlide_R.play();
      image(BatSlide_R, X, Y-ImgPos);
      
      Anim=0;
      break;
    case 4:      //BatSlide_L   
          BatSlide_L.play();
      image(BatSlide_L, X, Y-ImgPos);
      Anim=0;
      break;
    case 5:       //BatIdle_Happy
      image(BatIdle_Happy, X, Y-ImgPos);
      BatIdle_Happy.play();
      BatDive_Happy.ignoreRepeat();
      CountIdleHappy++;
      if (CountIdleHappy==25) {
        Anim=0;
      }
      break;
    case 6:      //Bat_Death
      BatDeath.play();
      image(BatDeath, X, Y-ImgPos);
      break;
    case 7:      //Bat_Death_Pose
      image(BatDeathPose, X, Y-ImgPos);
      break;
    }
  }

  void Controller(int Player) {

    if (Player ==1) {
      if (Health>0) {
        Control=true;
        float targetX = mouseX;
        float dx = targetX - PlayerX;
        PlayerX += dx * easing;

        if (PlayerX+100<mouseX)
          Anim=3;
        if (PlayerX-100>mouseX)
          Anim=4;
        //circle(targetX, height/2, 20);
        //fill(0);
        //circle(PlayerX, height/2, 10);
        float targetY = 400+50;
        float dy = targetY - PlayerY;
        PlayerY += dy * easing;
        //PlayerX=mouseX;
      } else 
      Control = false;
    }

    if (Player ==2) {
      //circle(targetX_P2, height/2, 20);
      //fill(0);
      //circle(PlayerX, height/2, 10);

      if (Health>0) {
        Control=true;

        if (keyPressed) {

          if (key =='a' && targetX_P2>10) {

            if (P2Slide && PlayerX>targetX_P2+50) 
              Anim=4;

            targetX_P2 += -25;
          }
          if (key =='d' && targetX_P2<width-10) {

            if (P2Slide && PlayerX<targetX_P2-50) 
              Anim=3;

            targetX_P2 += +25;
          } else 
          P2Slide=true;
        }
        float dx = targetX_P2 - PlayerX;
        PlayerX += dx * easing;
        if  (PlayerX<0)
          PlayerX=0;
        if (PlayerX>width)
          PlayerX=width;
        float targetY = 400+50;
        float dy = targetY - PlayerY;
        PlayerY += dy * easing;
        //PlayerX=mouseX;
      } else 
      Control = false;
    }
  }


  boolean PlayerCursor(int num) {
    if (Control) {
      fill(0);
      text ("P" + num, PlayerX-20, PlayerY-200);
      if (num==1)
        fill(Yellow);
      if (num==2)
        fill (Green);
      text ("P" + num, PlayerX-20, PlayerY-205);
      noFill();
    }
    return true;
  }
}
